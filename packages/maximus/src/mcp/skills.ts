/**
 * The MCP Skills extension (SEP-2640): `skills/list` and `skills/get` describe each skill by its
 * frontmatter and the manifest of its one file, whose size and SHA-256 digest hosts verify, and
 * `resources/read` serves that `SKILL.md`. An optional tool serves the same skills to clients that import
 * only tools.
 */
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { CallToolResult, McpServer, StandardSchemaV1, Tool } from '@modelcontextprotocol/server';
import { Type } from '@sinclair/typebox';
import type { Static, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import type { McpSkill } from '../index.ts';
import { sha256Hex } from '../internal/digest.ts';
import { toYaml } from '../internal/yaml.ts';

/** The official Skills extension (SEP-2640) a server declares in its capabilities. */
export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills';

/** Skills change only with a deployment and are the same for every caller, so hosts may share them. */
const SKILL_CACHE = { ttlMs: 300_000, cacheScope: 'public' } as const;

/** Adapts a TypeBox schema to the Standard Schema the SDK validates custom method params with. */
function standardSchema<T extends TSchema>(schema: T): StandardSchemaV1<unknown, Static<T>> {
  return {
    '~standard': {
      version: 1,
      vendor: 'maximus',
      validate: (value) =>
        Value.Check(schema, value) ? { value } : { issues: [{ message: 'Invalid params' }] },
    },
  };
}
/** `skills/list` params: an optional page cursor, which one page of every skill never issues. */
const ListSkillsParams = standardSchema(Type.Object({ cursor: Type.Optional(Type.String()) }));
/** `skills/get` params: the URI of the skill's `SKILL.md`. */
const GetSkillParams = standardSchema(Type.Object({ uri: Type.String() }));

/**
 * A skill's `SKILL.md` URI, `skill://<name>/SKILL.md`: the file's directory carries the skill's name, as
 * SEP-2640 requires.
 */
function skillUri(skill: McpSkill): string {
  return `skill://${skill.name}/SKILL.md`;
}

/** The served `SKILL.md`: frontmatter generated from the name and description, then the instructions. */
function skillDocument(skill: McpSkill): string {
  const frontmatter = toYaml({ name: skill.name, description: skill.description });
  return `---\n${frontmatter}---\n\n${skill.text.trim()}\n`;
}

/** A catalog entry. Hosts verify every file they read against its manifest's size and SHA-256 digest. */
async function skillEntry(skill: McpSkill) {
  const uri = skillUri(skill);
  const bytes = new TextEncoder().encode(skillDocument(skill));
  return {
    uri,
    frontmatter: { name: skill.name, description: skill.description },
    resources: [{ uri, digest: `sha256:${await sha256Hex(bytes)}`, size: bytes.byteLength }],
  };
}

/**
 * Serve skills through the Skills extension: `skills/list`, `skills/get`, and `resources/read` of each
 * `SKILL.md`, each request answered through `answer`, which counts it against the caller's rate limit.
 * Clients without the extension still find the files among the server's resources.
 */
export function registerSkills(
  server: McpServer,
  skills: readonly McpSkill[],
  answer: <R>(work: () => R | Promise<R>) => Promise<R>
): void {
  for (const skill of skills) {
    const uri = skillUri(skill);
    server.registerResource(
      skill.name,
      uri,
      { description: skill.description, mimeType: 'text/markdown', cacheHint: SKILL_CACHE },
      () => answer(() => ({ contents: [{ uri, mimeType: 'text/markdown', text: skillDocument(skill) }] }))
    );
  }
  server.server.setRequestHandler('skills/list', { params: ListSkillsParams }, (params) =>
    answer(async () => {
      // One page holds every skill, so the server never issues a cursor to come back with.
      if (params.cursor !== undefined) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid skills cursor');
      }
      return {
        resultType: 'complete' as const,
        skills: await Promise.all(skills.map(skillEntry)),
        ...SKILL_CACHE,
      };
    })
  );
  server.server.setRequestHandler('skills/get', { params: GetSkillParams }, (params) =>
    answer(async () => {
      const skill = skills.find((candidate) => skillUri(candidate) === params.uri);
      if (!skill) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown skill');
      }
      return { resultType: 'complete' as const, skill: await skillEntry(skill), ...SKILL_CACHE };
    })
  );
}

/**
 * The same skills as one read-only tool, for clients that import only tools. Its description names every
 * skill, so a semantic tool search for one of those tasks can find it.
 */
export function skillTool(name: string, skills: readonly McpSkill[]): Tool {
  return {
    name,
    title: 'Read a workflow skill',
    description: [
      'Read the instructions of one workflow skill before doing its task: the steps, tools and pitfalls of work that spans several tools. A skill grants no tools or permissions.',
      'Skills:',
      ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: skills.map((skill) => skill.name), description: 'The skill to read.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        instructions: { type: 'string', description: 'The Markdown instructions.' },
      },
      required: ['name', 'description', 'instructions'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };
}

/** Answer a skill tool call. An unknown name is a tool error, which the model can correct. */
export function readSkill(skills: readonly McpSkill[], input: Record<string, unknown>): CallToolResult {
  const skill = skills.find((candidate) => candidate.name === input.name);
  if (!skill) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Unknown skill. Read one of: ${skills.map((entry) => entry.name).join(', ')}.`,
        },
      ],
    };
  }
  const value = { name: skill.name, description: skill.description, instructions: skill.text.trim() };
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}
