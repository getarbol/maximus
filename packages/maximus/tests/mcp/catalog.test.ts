/**
 * The tool catalog: 400 tools in pages of 50 behind version-bound cursors, filtered by the caller's
 * scopes like execution, the OpenAPI document and a guide served as resources and prompts, and the
 * execution metadata analytics records.
 */
import { ProtocolErrorCode } from '@modelcontextprotocol/server';
import { expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import { analytics } from '../../src/analytics/analytics.ts';
import type { ExecutionEvent } from '../../src/analytics/analytics.ts';
import { createHttpHandler as nativeHttp, defineErrors, EmptyInputSchema, ok } from '../../src/index.ts';
import { composeOperations, defineApp, operation } from '../../src/internals.ts';
import { mcp } from '../../src/mcp/index.ts';

const createHttpHandler: typeof nativeHttp = (manifest, options = {}) =>
  nativeHttp(manifest, { ...options, transports: [mcp()] });

const base = {
  scope: 'demo:records:read',
  title: 'Read',
  description: 'Read a safe record',
  effect: 'read' as const,
  input: EmptyInputSchema,
  output: EmptyInputSchema,
  execute: async () => ok({}),
};
const make = (index: number) =>
  operation({
    ...base,
    http: { method: 'GET', path: `/v1/records/r${index}` },
    mcp: { name: `record_${index}`, idempotent: true },
  });
const manifest = defineApp<Record<string, never>, null>()({
  name: 'demo',
  namespace: 'demo',
  title: 'Demo',
  version: '2',
  origin: 'https://example.test',
  tokens: { issuer: 'https://issuer.example.test/', audience: 'demo' },
  errors: defineErrors({}),
  context: async () => ok(null),
  rpc: { callers: [] },
  mcp: { guides: [{ name: 'usage', title: 'Usage', text: 'Read before writing.' }] },
  operations: composeOperations(
    Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`read${i}`, make(i)])),
    { internal: operation({ ...base, rpc: true }) }
  ),
});
const claims = {
  sub: 'client@clients',
  client_id: 'client',
  org_id: 'org_1234567890abcdef',
  scope: 'demo:records:read demo:mcp:use',
};
const request = (path: string, body?: object) =>
  new Request(`https://example.test${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: 'Bearer a.b.c',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
async function rpc(
  handle: (request: Request, env: Record<string, never>) => Promise<Response>,
  method: string,
  params: object = {}
) {
  const response = await handle(request('/mcp', { jsonrpc: '2.0', id: 1, method, params }), {});
  const text = await response.text();
  return JSON.parse(/data: (\{[^\n]*)/.exec(text)?.[1] ?? text);
}
it('pages 400 tools, filters authority and publishes the same contract through MCP resources', async () => {
  const handle = createHttpHandler(manifest, { verify: async () => claims });
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const { result } = await rpc(handle, 'tools/list', cursor ? { cursor } : {});
    expect(result.tools.length).toBeLessThanOrEqual(50);
    names.push(...result.tools.map((tool: { name: string }) => tool.name));
    cursor = result.nextCursor;
  } while (cursor);
  expect(new Set(names).size).toBe(400);
  expect(names).not.toContain('internal');
  const schema = await (await handle(request('/openapi.json'), {})).json();
  expect(Object.keys((schema as { paths: object }).paths)).toHaveLength(400);
  const resource = await rpc(handle, 'resources/read', { uri: 'https://example.test/openapi.yaml' });
  expect(parse(resource.result.contents[0].text)).toEqual(schema);
  expect((await rpc(handle, 'prompts/get', { name: 'usage' })).result.messages[0].content.text).toBe(
    'Read before writing.'
  );
  const denied = createHttpHandler(manifest, { verify: async () => ({ ...claims, scope: 'demo:mcp:use' }) });
  expect((await rpc(denied, 'tools/list')).result.tools).toEqual([]);
  expect((await rpc(denied, 'tools/call', { name: 'record_0', arguments: {} })).error).toBeDefined();
  expect(() => composeOperations({ same: make(1) }, { same: make(2) })).toThrow('Duplicate');
}, 30_000);
it('names each OpenAPI resource by the URL that serves it, below a base path', async () => {
  // One operation keeps the documents small: what matters is where they are named and served.
  const small = { ...manifest, operations: { read0: make(0) } };
  const handle = createHttpHandler(small, { verify: async () => claims, basePath: '/api' });
  const { result } = await rpc(handle, 'resources/list');
  const documents = (result.resources as { uri: string }[])
    .map(({ uri }) => uri)
    .filter((uri) => uri.includes('/openapi.'));
  expect(documents).toEqual([
    'https://example.test/api/openapi.json',
    'https://example.test/api/openapi.yaml',
  ]);
  for (const uri of documents) {
    // A client that fetches what the resource names gets the document the resource reads.
    const served = await handle(new Request(uri), {});
    expect(served.status, uri).toBe(200);
    const read = await rpc(handle, 'resources/read', { uri });
    expect(parse(read.result.contents[0].text), uri).toEqual(parse(await served.text()));
  }
});
it('answers a cursor this version did not issue to this caller with invalid params', async () => {
  const handle = createHttpHandler(manifest, { verify: async () => claims });
  const { nextCursor } = (await rpc(handle, 'tools/list')).result;
  expect((await rpc(handle, 'tools/list', { cursor: nextCursor })).result.tools).toHaveLength(50);
  const redeployed = createHttpHandler({ ...manifest, version: '3' }, { verify: async () => claims });
  const denied = createHttpHandler(manifest, { verify: async () => ({ ...claims, scope: 'demo:mcp:use' }) });
  // The client then lists again from the start, as the pagination spec asks.
  for (const [label, handler, cursor] of [
    ['made up', handle, 'next'],
    ['empty', handle, ''],
    ['another version', redeployed, nextCursor],
    ['a tool the caller cannot see', denied, nextCursor],
  ] as const) {
    expect((await rpc(handler, 'tools/list', { cursor })).error, label).toMatchObject({
      code: ProtocolErrorCode.InvalidParams,
      message: 'Invalid cursor',
    });
  }
});
it('records safe execution metadata after response and can disable it', async () => {
  const record = vi.fn(async (_env: Record<string, never>, _event: ExecutionEvent) => undefined);
  const handle = createHttpHandler(
    { ...manifest, telemetry: { observers: [analytics({ record })] } },
    { verify: async () => claims }
  );
  const tasks: Promise<unknown>[] = [];
  expect(
    (await handle(request('/v1/records/r0'), {}, { waitUntil: (task) => tasks.push(task) })).status
  ).toBe(200);
  await Promise.all(tasks);
  expect(record).toHaveBeenCalledOnce();
  expect(record.mock.calls[0]?.[1]).toMatchObject({
    organizationId: claims.org_id,
    outcome: 'success',
    traceId: null,
    operation: 'read0',
  });
  expect(JSON.stringify(record.mock.calls)).not.toContain('Bearer');
  const off = createHttpHandler(
    { ...manifest, telemetry: { enabled: false, observers: [analytics({ record })] } },
    { verify: async () => claims }
  );
  await off(request('/v1/records/r0'), {}, { waitUntil: (task) => tasks.push(task) });
  await Promise.all(tasks);
  expect(record).toHaveBeenCalledOnce();
});
