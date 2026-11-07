/**
 * The MCP Skills extension (SEP-2640), served by the SDK's `SkillCatalog`: `skills/list`, `skills/get` and
 * `resources/read` of each skill's one file, `skill://<name>/SKILL.md`, whose size and SHA-256 digest hosts
 * verify. An optional tool serves the same skills to clients that import only tools.
 */
import type { CallToolResult, Tool } from '@modelcontextprotocol/server';
import { memorySkillFiles, SkillCatalog } from '@modelcontextprotocol/server/ext/skills';

import type { McpSkill } from '../index.ts';
import { toYaml } from '../internal/yaml.ts';

/** Skills change only with a deployment and are the same for every caller, so hosts may share them. */
const SKILL_CACHE = { ttlMs: 300_000, cacheScope: 'public' } as const;

/** Each application's catalog, built on first use: an application's skills never change. */
const catalogs = new WeakMap<readonly McpSkill[], SkillCatalog>();

/** The served `SKILL.md`: frontmatter generated from the name and description, then the instructions. */
function skillDocument(skill: McpSkill): string {
  const frontmatter = toYaml({ name: skill.name, description: skill.description });
  return `---\n${frontmatter}---\n\n${skill.text.trim()}\n`;
}

/**
 * The catalog that serves the skills through the Skills extension, each as `skill://<name>/SKILL.md`, every
 * one on a single `skills/list` page, with the public cache hint. Building it checks each skill as hosts do,
 * and throws for one they would refuse.
 */
export async function skillCatalog(skills: readonly McpSkill[]): Promise<SkillCatalog> {
  let catalog = catalogs.get(skills);
  if (!catalog) {
    const files = Object.fromEntries(skills.map((skill) => [`${skill.name}/SKILL.md`, skillDocument(skill)]));
    catalog = await SkillCatalog.load(memorySkillFiles(files), {
      cacheHint: SKILL_CACHE,
      pageSize: Number.POSITIVE_INFINITY,
      strict: true,
    });
    catalogs.set(skills, catalog);
  }
  return catalog;
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

/** Answers a skill tool call. An unknown name is a tool error, which the model can correct. */
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
