/**
 * MCP listings and calls the other suites leave out: a union input whose member is a named recursive
 * definition, listed as one object beside its `$defs`; fields the members declare differently listed as
 * choices and no field required that some member omits, every call still checked against the exact union; calls without arguments, to an operation and to the skill tool; a guide
 * read as a resource; and a server that fails on its own answering 500, reported by a safe description
 * correlated with the request and never with its text.
 */
import { expect, it, vi } from 'vite-plus/test';

import { createHttpHandler, defineErrors, ok, t } from '../../src/index.ts';
import type { AppManifest, McpGuide, OperationShape } from '../../src/index.ts';
import { defineApp, operation } from '../../src/internals.ts';
import { mcp } from '../../src/mcp/index.ts';

const strict = { additionalProperties: false } as const;
/** A folder holds folders: a recursive member, named so its listing refers to it. */
const Folder = t.Recursive(
  (Self) =>
    t.Object(
      { kind: t.Literal('folder'), name: t.String(), entries: t.Array(Self, { maxItems: 8 }) },
      strict
    ),
  { $id: 'Folder' }
);
const File = t.Object({ kind: t.Literal('file'), name: t.String(), size: t.Integer({ minimum: 0 }) }, strict);
/** A reminder after a delay or at a time: the label is text for one and a number for the other. */
const Reminder = t.Union([
  t.Object(
    {
      kind: t.Optional(t.Literal('delay')),
      after: t.Integer({ minimum: 1 }),
      label: t.Optional(t.String({ maxLength: 40 })),
    },
    strict
  ),
  t.Object(
    {
      kind: t.Optional(t.Literal('time')),
      at: t.String({ format: 'date-time' }),
      label: t.Optional(t.Integer()),
    },
    strict
  ),
]);
const USAGE: McpGuide = { name: 'usage', title: 'Usage', text: '# Usage\n\nOrganize before you schedule.' };
const organize = vi.fn(async (_context: null, input: { name: string }) => ok({ name: input.name }));
const schedule = vi.fn(async () => ok({ scheduled: true }));
const manifest = defineApp<Record<string, never>, null>()({
  name: 'listing',
  namespace: 'listing',
  title: 'Listing',
  version: '1',
  origin: 'https://example.test',
  tokens: { issuer: 'https://issuer.example.test/', audience: 'https://example.test' },
  errors: defineErrors({}),
  context: async () => ok(null),
  rpc: { callers: [] },
  mcp: {
    guides: [USAGE],
    skills: [{ name: 'weekly-review', description: 'Review the week.', text: 'Close what is done.' }],
    skillTool: 'read_skill',
  },
  operations: {
    organizeEntry: operation({
      http: { method: 'POST', path: '/v1/entries/organize' },
      effect: 'write',
      scope: 'listing:entries:write',
      title: 'Organize an entry',
      description: 'File one folder or file.',
      input: t.Union([Folder, File]),
      output: t.Object({ name: t.String() }, strict),
      mcp: { name: 'organize_entry', idempotent: false },
      execute: organize,
    }),
    scheduleReminder: operation({
      http: { method: 'POST', path: '/v1/reminders' },
      effect: 'write',
      scope: 'listing:entries:write',
      title: 'Schedule a reminder',
      description: 'Remind after a delay or at a time.',
      input: Reminder,
      output: t.Object({ scheduled: t.Boolean() }, strict),
      mcp: { name: 'schedule_reminder', idempotent: false },
      execute: schedule,
    }),
    pingService: operation({
      http: { method: 'POST', path: '/v1/ping' },
      effect: 'read',
      scope: 'listing:entries:write',
      title: 'Ping',
      description: 'Answer that the service is up.',
      input: t.Object({}, strict),
      output: t.Object({ pong: t.Boolean() }, strict),
      mcp: { name: 'ping_service', idempotent: true },
      execute: async () => ok({ pong: true }),
    }),
  },
});
const claims = {
  sub: 'client@clients',
  client_id: 'client',
  org_id: 'org_1234567890abcdef',
  scope: 'listing:entries:write listing:mcp:use',
};

/** One JSON-RPC request to the MCP endpoint of `app`: its status, its message and its headers. */
async function rpc(
  method: string,
  params: object,
  app: AppManifest<Record<string, never>, null, Record<string, OperationShape>> = manifest
) {
  const handle = createHttpHandler(app, { transports: [mcp()], verify: async () => claims });
  const response = await handle(
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
  return {
    status: response.status,
    text,
    headers: response.headers,
    message: response.status < 500 ? JSON.parse(/data: (\{[^\n]*)/.exec(text)?.[1] ?? text) : null,
  };
}

/** The listed tool `name`. */
async function listed(name: string) {
  const { message } = await rpc('tools/list', {});
  return (message.result.tools as { name: string; inputSchema: unknown }[]).find(
    (tool) => tool.name === name
  );
}

it('lists a union with a named recursive member as one object, its definition kept under $defs', async () => {
  const entries = { type: 'array', items: { $ref: '#/$defs/Folder' }, maxItems: 8 };
  expect((await listed('organize_entry'))?.inputSchema).toStrictEqual({
    type: 'object',
    $defs: {
      Folder: {
        type: 'object',
        properties: { kind: { type: 'string', const: 'folder' }, name: { type: 'string' }, entries },
        required: ['kind', 'name', 'entries'],
        additionalProperties: false,
      },
    },
    properties: {
      kind: { type: 'string', enum: ['folder', 'file'] },
      name: { type: 'string' },
      entries,
      size: { type: 'integer', minimum: 0 },
    },
    required: ['kind', 'name'],
    additionalProperties: false,
  });
  const nested = { kind: 'folder', name: 'Q3', entries: [{ kind: 'folder', name: 'Drafts', entries: [] }] };
  expect(
    (await rpc('tools/call', { name: 'organize_entry', arguments: nested })).message.result
  ).toMatchObject({
    structuredContent: { name: 'Q3' },
  });
  // The listing admits a file with entries; the union does not, and the handler never runs.
  organize.mockClear();
  const refused = await rpc('tools/call', {
    name: 'organize_entry',
    arguments: { kind: 'file', name: 'report.pdf', size: 10, entries: [] },
  });
  expect(refused.message.result.isError).toBe(true);
  expect(JSON.parse(refused.message.result.content[0].text)).toMatchObject({ code: 'INVALID_INPUT' });
  expect(organize).not.toHaveBeenCalled();
});

it('lists fields the members declare differently as choices, and requires no field a member omits', async () => {
  expect((await listed('schedule_reminder'))?.inputSchema).toStrictEqual({
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['delay', 'time'] },
      after: { type: 'integer', minimum: 1 },
      label: { anyOf: [{ type: 'string', maxLength: 40 }, { type: 'integer' }] },
      at: { type: 'string', format: 'date-time' },
    },
    additionalProperties: false,
  });
  const at = { kind: 'time', at: '2026-11-01T09:00:00Z', label: 3 };
  expect(
    (await rpc('tools/call', { name: 'schedule_reminder', arguments: at })).message.result
  ).toMatchObject({
    structuredContent: { scheduled: true },
  });
  // Every listed field is allowed, yet a delay labelled with a number is no member.
  schedule.mockClear();
  const mixed = await rpc('tools/call', { name: 'schedule_reminder', arguments: { after: 5, label: 3 } });
  expect(mixed.message.result.isError).toBe(true);
  expect(schedule).not.toHaveBeenCalled();
});

it('calls a tool without arguments as with an empty input, and the skill tool without a name as an unknown skill', async () => {
  expect((await rpc('tools/call', { name: 'ping_service' })).message.result).toMatchObject({
    structuredContent: { pong: true },
  });
  expect((await rpc('tools/call', { name: 'read_skill' })).message.result).toStrictEqual({
    isError: true,
    content: [{ type: 'text', text: 'Unknown skill. Read one of: weekly-review.' }],
  });
});

it('serves a guide as a Markdown resource at its URI', async () => {
  const uri = 'https://example.test/guides/usage';
  expect((await rpc('resources/read', { uri })).message.result.contents).toStrictEqual([
    { uri, mimeType: 'text/markdown', text: USAGE.text },
  ]);
});

it('answers 500 when the server fails on its own, reported by a safe description correlated with the request', async () => {
  // Two guides of one name, which .build() refuses: the server cannot register both.
  const broken = { ...manifest, mcp: { ...manifest.mcp, guides: [USAGE, USAGE] } };
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const answered = await rpc('tools/list', {}, broken);
    expect(answered.status).toBe(500);
    expect(answered.text).not.toMatch(/already registered|guides\/usage/);
    const reports = log.mock.calls.map(([line]) => String(line));
    expect(reports.map((line) => JSON.parse(line))).toMatchObject([
      {
        event: 'maximus.unexpected',
        surface: 'mcp',
        requestId: answered.headers.get('x-request-id'),
        name: 'Error',
      },
    ]);
    expect(reports.join('')).not.toMatch(/already registered|guides\/usage|transport failure/);
  } finally {
    log.mockRestore();
  }
});
