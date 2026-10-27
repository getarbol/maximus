/**
 * MCP mounted at the root of a dedicated host: real Streamable HTTP initialization, the 401 challenge
 * and its metadata, and the origin's tools behind the same all-of scope and actor checks for listing and
 * calls.
 */
import { ProtocolErrorCode } from '@modelcontextprotocol/server';
import { expect, it, vi } from 'vite-plus/test';

import { createHttpHandler, defineErrors, maximus, ok, t } from '../../src/index.ts';
import { mcp } from '../../src/mcp/index.ts';

const schema = t.Object({}, { additionalProperties: false });
const execute = vi.fn(async () => ok({}));
const fullScopes = ['fixture:mcp:use', 'fixture:records:read', 'fixture:site:read'];
function application() {
  const base = maximus<Record<string, never>>({
    name: 'fixture',
    namespace: 'fixture',
    version: '1',
    title: 'Fixture',
    origin: 'https://mcp.example.test',
    mcp: {},
    errors: defineErrors({}),
    rpc: { callers: [] },
    telemetry: { enabled: false },
    tokens: { issuer: 'https://issuer.example.test/', audience: 'https://mcp.example.test' },
  });
  const definition = {
    scope: ['fixture:records:read', 'fixture:site:read'] as const,
    scopeMatch: 'all' as const,
    title: 'Read',
    description: 'Read permitted records.',
    input: schema,
    output: schema,
    effect: 'read' as const,
    actorKinds: ['user'] as const,
    mcp: { name: 'read_records', idempotent: true },
  };
  return base
    .operation('read', definition, execute)
    .operation('hidden', { ...definition, mcp: { name: 'hidden_records', idempotent: true } }, execute)
    .build();
}
/** The service as `subject` calls it with `scopes`: a person, or the approved client's machine. */
function handler(scopes = fullScopes, subject = 'person') {
  return createHttpHandler(application(), {
    transports: [mcp({ path: '/' })],
    origins: ['https://mcp.example.test'],
    verify: async () => ({
      sub: subject,
      azp: 'approved',
      org_id: 'org_1234567890abcdef',
      scope: scopes.join(' '),
      permissions: scopes,
    }),
  });
}
const request = (method: string, params: object, path = '/') =>
  new Request(`https://mcp.example.test${path}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer a.b.c',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
async function body(response: Response) {
  const text = await response.text();
  return JSON.parse(/data: (\{[^\n]*)/.exec(text)?.[1] ?? text);
}

it('mounts real Streamable HTTP at root, including initialization and authenticated GET rather than landing JSON', async () => {
  const handle = handler();
  const initialized = await body(
    await handle(
      request('initialize', {
        protocolVersion: '2026-07-28',
        capabilities: {},
        clientInfo: { name: 'fixture-client', version: '1' },
      }),
      {}
    )
  );
  expect(initialized.result.serverInfo.name).toBe('fixture');
  expect(initialized.result.capabilities.tools).toBeDefined();
  const get = await handle(
    new Request('https://mcp.example.test/', { headers: { accept: 'text/event-stream' } }),
    {}
  );
  expect(get.status).toBe(401);
  expect(get.headers.get('www-authenticate')).toBe(
    'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource"'
  );
  const metadata = await handle(
    new Request('https://mcp.example.test/.well-known/oauth-protected-resource'),
    {}
  );
  expect(await metadata.json()).toMatchObject({ resource: 'https://mcp.example.test' });
  expect(metadata.headers.get('access-control-allow-origin')).toBe('*');
  expect((await handle(request('tools/list', {}, '/mcp'), {})).status).toBe(404);
  expect(
    (await handle(new Request('https://api.example.test/.well-known/oauth-protected-resource'), {})).status
  ).toBe(404);
});

it('serves every declared tool on the origin, with the same all-of checks for discovery and execution', async () => {
  execute.mockClear();
  const handle = handler();
  const listed = await body(await handle(request('tools/list', {}), {}));
  expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
    'read_records',
    'hidden_records',
  ]);
  const missing = await body(
    await handle(request('tools/call', { name: 'missing_records', arguments: {} }), {})
  );
  expect(missing.error).toBeDefined();
  const partial = handler(['fixture:mcp:use', 'fixture:records:read']);
  expect((await body(await partial(request('tools/list', {}), {}))).result.tools).toEqual([]);
  expect(
    (await body(await partial(request('tools/call', { name: 'hidden_records', arguments: {} }), {}))).error
  ).toBeDefined();
  expect(execute).not.toHaveBeenCalled();
  expect(
    (await body(await handle(request('tools/call', { name: 'hidden_records', arguments: {} }), {}))).result
      .structuredContent
  ).toEqual({});
  expect(execute).toHaveBeenCalledTimes(1);
});

it('hides the tools only people may call from a machine, in listing and in calls', async () => {
  execute.mockClear();
  // The machine holds every scope the person does: only its actor kind keeps it out.
  const machine = handler(fullScopes, 'approved@clients');
  expect((await body(await machine(request('tools/list', {}), {}))).result.tools).toEqual([]);
  expect(
    (await body(await machine(request('tools/call', { name: 'read_records', arguments: {} }), {}))).error
  ).toMatchObject({ code: ProtocolErrorCode.InvalidParams, message: 'Tool not found' });
  expect(execute).not.toHaveBeenCalled();
});
