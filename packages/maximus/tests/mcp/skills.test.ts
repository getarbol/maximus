/**
 * The Skills extension (SEP-2640): the declared extension, `skills/list` and `skills/get` entries whose
 * manifest a host verifies against the served `SKILL.md` (size, SHA-256 digest and frontmatter), invalid
 * params for an unknown skill or a cursor, the public cache hint on both eras, and the skill tool.
 */
import { ProtocolErrorCode } from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

import { createHttpHandler, defineErrors, EmptyInputSchema, ok } from '../../src/index.ts';
import type { McpSkill } from '../../src/index.ts';
import { composeOperations, defineApp, operation } from '../../src/internals.ts';
import { mcp } from '../../src/mcp/index.ts';
import { SKILLS_EXTENSION } from '../../src/mcp/skills.ts';

/** Its description needs YAML quoting (a colon, a `#` and quotes) and has a character of three bytes. */
const REVIEW: McpSkill = {
  name: 'weekly-review',
  description: 'Review the open records: close the "done" ones — #weekly, every Friday.',
  text: '# Weekly review\n\n1. Call `record_0`.\n2. Close what is done.\n',
};
/** A description YAML would read as a boolean unless it is quoted. */
const TRIAGE: McpSkill = { name: 'triage', description: 'true', text: 'Sort new records by urgency.' };
/** The skills the service serves, in the order it lists them. */
const SKILLS = [REVIEW, TRIAGE];

/** One more operation than a `tools/list` page holds, so a second page exists. */
const records = Object.fromEntries(
  Array.from({ length: 51 }, (_, index) => [
    `read${index}`,
    operation({
      scope: 'skills:records:read',
      title: 'Read',
      description: 'Read a record.',
      effect: 'read',
      input: EmptyInputSchema,
      output: EmptyInputSchema,
      mcp: { name: `record_${index}`, idempotent: true },
      execute: async () => ok({}),
    }),
  ])
);
/** A service that serves the skills, and the skill tool beside its 51 tools. */
const manifest = defineApp<Record<string, never>, null>()({
  name: 'skills',
  namespace: 'skills',
  title: 'Skills',
  version: '1',
  origin: 'https://example.test',
  tokens: { issuer: 'https://issuer.example.test/', audience: 'https://example.test' },
  errors: defineErrors({}),
  context: async () => ok(null),
  rpc: { callers: [] },
  mcp: { skills: SKILLS, skillTool: 'read_skill' },
  operations: composeOperations(records),
});
/** A service token that may open the endpoint and read records. */
const claims = {
  sub: 'client@clients',
  client_id: 'client',
  org_id: 'org_1234567890abcdef',
  scope: 'skills:records:read skills:mcp:use',
};
/** The service over HTTP with the MCP transport mounted at `/mcp`. */
const handle = createHttpHandler(manifest, { transports: [mcp()], verify: async () => claims });
/** The same service configured without skills. */
const withoutSkills = createHttpHandler(
  { ...manifest, mcp: {} },
  { transports: [mcp()], verify: async () => claims }
);

/** One JSON-RPC response to a request a 2025-era client posts. */
async function rpc(method: string, params: object = {}, handler = handle) {
  const response = await handler(
    new Request('https://example.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer a.b.c',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
    {}
  );
  const text = await response.text();
  return JSON.parse(/data: (\{[^\n]*)/.exec(text)?.[1] ?? text);
}

/** One JSON-RPC response to a `resources/read` a 2026-07-28 client posts. */
async function modernRead(uri: string) {
  const response = await handle(
    new Request('https://example.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer a.b.c',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'resources/read',
        'mcp-name': uri,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: {
          uri,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    }),
    {}
  );
  return JSON.parse(await response.text());
}

/** The lowercase hexadecimal SHA-256 digest of some bytes. */
async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

it('lists each skill with a manifest whose size, digest and frontmatter match its SKILL.md', async () => {
  const initialized = await rpc('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'host', version: '1' },
  });
  expect(initialized.result.capabilities).toMatchObject({
    resources: {},
    extensions: { [SKILLS_EXTENSION]: {} },
  });
  const listed = (await rpc('skills/list')).result;
  expect(listed).toMatchObject({ resultType: 'complete', ttlMs: 300_000, cacheScope: 'public' });
  expect(listed).not.toHaveProperty('nextCursor');
  expect(listed.skills).toHaveLength(SKILLS.length);
  for (const [index, skill] of SKILLS.entries()) {
    const entry = listed.skills[index];
    expect(entry.uri).toBe(`skill://${skill.name}/SKILL.md`);
    expect(entry.frontmatter).toStrictEqual({ name: skill.name, description: skill.description });
    // The manifest is the one file the skill has, and its directory carries the skill's name.
    expect(entry.resources).toStrictEqual([
      { uri: entry.uri, digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), size: expect.any(Number) },
    ]);
    expect(entry.uri.split('/').at(-2)).toBe(entry.frontmatter.name);
    const { contents } = (await rpc('resources/read', { uri: entry.uri })).result;
    expect(contents).toStrictEqual([{ uri: entry.uri, mimeType: 'text/markdown', text: expect.any(String) }]);
    // What a host checks before it loads the instructions.
    const bytes = new TextEncoder().encode(contents[0].text);
    expect(bytes.byteLength).toBe(entry.resources[0].size);
    expect(entry.resources[0].digest).toBe(`sha256:${await sha256(bytes)}`);
    const [, frontmatter, body] = /^---\n([\s\S]*?)---\n\n([\s\S]*)$/.exec(contents[0].text) ?? [];
    expect(parse(frontmatter ?? '')).toStrictEqual(entry.frontmatter);
    expect(body).toBe(`${skill.text.trim()}\n`);
  }
  const { resources } = (await rpc('resources/list')).result;
  expect(resources).toEqual(
    expect.arrayContaining(
      SKILLS.map((skill) =>
        expect.objectContaining({ uri: `skill://${skill.name}/SKILL.md`, description: skill.description })
      )
    )
  );
  // A 2026-07-28 read carries the same public cache hint as the listing.
  expect((await modernRead(listed.skills[0].uri)).result).toMatchObject({
    resultType: 'complete',
    ttlMs: 300_000,
    cacheScope: 'public',
  });
});

it('gets one skill by URI, and answers an unknown skill or any cursor with invalid params', async () => {
  const listed = (await rpc('skills/list')).result.skills;
  expect((await rpc('skills/get', { uri: 'skill://triage/SKILL.md' })).result).toStrictEqual({
    resultType: 'complete',
    skill: listed[1],
    ttlMs: 300_000,
    cacheScope: 'public',
  });
  for (const [method, params] of [
    ['skills/get', { uri: 'skill://unknown/SKILL.md' }],
    ['skills/get', { uri: 'https://example.test/openapi.json' }],
    ['skills/get', {}],
    ['skills/list', { cursor: 'next' }],
  ] as const) {
    expect((await rpc(method, params)).error, `${method} ${JSON.stringify(params)}`).toMatchObject({
      code: ProtocolErrorCode.InvalidParams,
    });
  }
});

it('serves the skills as one read-only tool that leads the first page only', async () => {
  const first = (await rpc('tools/list')).result;
  expect(first.tools).toHaveLength(51);
  expect(first.tools[0]).toMatchObject({
    name: 'read_skill',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { properties: { name: { enum: ['weekly-review', 'triage'] } }, required: ['name'] },
  });
  for (const skill of SKILLS) {
    expect(first.tools[0].description).toContain(`- ${skill.name}: ${skill.description}`);
  }
  const second = (await rpc('tools/list', { cursor: first.nextCursor })).result;
  expect(second.tools.map(({ name }: { name: string }) => name)).toEqual(['record_50']);
  const read = await rpc('tools/call', { name: 'read_skill', arguments: { name: 'weekly-review' } });
  expect(read.result.structuredContent).toStrictEqual({
    name: REVIEW.name,
    description: REVIEW.description,
    instructions: REVIEW.text.trim(),
  });
  expect(JSON.parse(read.result.content[0].text)).toStrictEqual(read.result.structuredContent);
  // An unknown name is a tool error that names the skills, so the model can correct itself.
  const unknown = await rpc('tools/call', { name: 'read_skill', arguments: { name: 'monthly-review' } });
  expect(unknown.result.isError).toBe(true);
  expect(unknown.result.content[0].text).toContain('weekly-review, triage');
});

it('declares no extension, no skill tool and no skill method without skills', async () => {
  const initialized = await rpc(
    'initialize',
    { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'host', version: '1' } },
    withoutSkills
  );
  expect(initialized.result.capabilities).not.toHaveProperty('extensions');
  expect((await rpc('skills/list', {}, withoutSkills)).error).toMatchObject({
    code: ProtocolErrorCode.MethodNotFound,
  });
  expect((await rpc('tools/list', {}, withoutSkills)).result.tools[0].name).toBe('record_0');
  const { resources } = (await rpc('resources/list', {}, withoutSkills)).result;
  expect(resources.some(({ uri }: { uri: string }) => uri.startsWith('skill://'))).toBe(false);
});
