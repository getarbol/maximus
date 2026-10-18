/**
 * One operation over REST and MCP: the same handler and tenant context, OAuth scopes, rate limits and
 * body bounds before execution, hidden tools, and business input and output checked once.
 */
import { FormatRegistry } from '@sinclair/typebox';
import { describe, it, expect, vi } from 'vitest';

import {
  t,
  defineErrors,
  ok,
  createHttpHandler as nativeHttp,
  createTokenAuthorization,
} from '../../src/index.ts';
import { defineApp, operation } from '../../src/internals.ts';
import { mcp as mcpTransport } from '../../src/mcp/index.ts';

const createHttpHandler: typeof nativeHttp = (manifest, options = {}) =>
  nativeHttp(manifest, { ...options, transports: [mcpTransport()] });

const errors = defineErrors({
  provider: { code: 'PROVIDER_FAILED', status: 503, message: 'The provider failed.' },
});
const claims = {
  sub: 'person',
  azp: 'client',
  org_id: 'org_1234567890abcdef',
  scope: 'test:records:read test:mcp:use',
  permissions: ['test:records:read', 'test:mcp:use'],
};
const execute = vi.fn(async (context: { organizationId: string }, input: { documentNumber: string }) =>
  ok({ documentNumber: input.documentNumber, organization: context.organizationId })
);
const manifest = defineApp<Record<string, never>, { organizationId: string }>()({
  name: 'test',
  namespace: 'test',
  mcp: {},
  title: 'Test',
  version: '1.0.0',
  origin: 'https://example.test',
  tokens: { issuer: 'https://issuer.example.test/', audience: 'https://example.test/mcp' },
  errors,
  context: async ({ principal }) => ok({ organizationId: principal.organizationId }),
  rpc: { callers: ['operator'] },
  operations: {
    lookup: operation({
      http: { method: 'POST', path: '/v1/records/lookup' },
      rpc: true,
      effect: 'read',
      scope: 'test:records:read',
      title: 'Lookup',
      description: 'Read one record',
      input: t.Object({ documentNumber: t.String() }, { additionalProperties: false }),
      output: t.Object(
        { documentNumber: t.String(), organization: t.String() },
        { additionalProperties: false }
      ),
      mcp: { name: 'lookup_record', idempotent: true },
      execute,
    }),
  },
});
const request = (path: string, body?: unknown, authorization = 'Bearer one.two.three') =>
  new Request(`https://example.test${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
describe('manifest transport', () => {
  it('generates matching runtime schemas without generated files', async () => {
    const handle = createHttpHandler(manifest, { verify: async () => claims });
    const json = (await (await handle(request('/openapi.json'), {})).json()) as {
      paths: Record<string, unknown>;
    };
    const { parse } = await import('yaml');
    const yaml = parse(await (await handle(request('/openapi.yaml'), {})).text());
    expect(yaml).toEqual(json);
    expect(Object.keys(json.paths)).toEqual(['/v1/records/lookup']);
  });
  it('uses one operation for REST and MCP, rejecting tenant overrides', async () => {
    const handle = createHttpHandler(manifest, { verify: async () => claims });
    const rest = await handle(request('/v1/records/lookup', { documentNumber: '123' }), {});
    expect(rest.status).toBe(200);
    expect(await rest.json()).toMatchObject({
      success: true,
      data: { documentNumber: '123', organization: claims.org_id },
    });
    const mcp = await handle(
      request('/mcp', {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'lookup_record', arguments: { documentNumber: '123' } },
      }),
      {}
    );
    const text = await mcp.text();
    const { result } = JSON.parse(/data: (\{[^\n]*)/.exec(text)?.[1] ?? text);
    expect(result.structuredContent).toEqual({ documentNumber: '123', organization: claims.org_id });
    expect(
      (await handle(request('/v1/records/lookup', { documentNumber: '123', organizationId: 'other' }), {}))
        .status
    ).toBe(400);
  });
  it('enforces OAuth scopes and rejects removed API keys', async () => {
    const auth = createTokenAuthorization(manifest.tokens, async () => claims);
    expect((await auth(request('/mcp'), 'test:mcp:use')).ok).toBe(true);
    expect((await auth(request('/mcp', undefined, 'Bearer api-key-deadbeef'), 'test:mcp:use')).ok).toBe(
      false
    );
    expect(
      (
        await createTokenAuthorization(manifest.tokens, async () => ({ ...claims, permissions: [] }))(
          request('/mcp'),
          'test:mcp:use'
        )
      ).ok
    ).toBe(false);
    expect(
      (
        await createTokenAuthorization(manifest.tokens, async () => ({ ...claims, sub: 'wrong@clients' }))(
          request('/mcp'),
          'test:mcp:use'
        )
      ).ok
    ).toBe(false);
    expect(
      (
        await createTokenAuthorization(manifest.tokens, async () => ({
          ...claims,
          sub: 'client@clients',
          permissions: undefined,
        }))(request('/mcp'), 'test:mcp:use')
      ).ok
    ).toBe(true);
  });
  it('isolates concurrent tenant contexts and rejects invalid output', async () => {
    const handle = createHttpHandler(manifest, {
      verify: async (token) => ({
        ...claims,
        org_id: token.startsWith('two.') ? 'org_abcdef1234567890' : claims.org_id,
      }),
    });
    const results = await Promise.all(
      ['one.two.three', 'two.one.three'].map(
        async (token) =>
          await (
            await handle(request('/v1/records/lookup', { documentNumber: '123' }, `Bearer ${token}`), {})
          ).json()
      )
    );
    expect(results).toMatchObject([
      { data: { organization: claims.org_id } },
      { data: { organization: 'org_abcdef1234567890' } },
    ]);
    execute.mockResolvedValueOnce(ok({ documentNumber: 123, secret: 'must-not-leak' }) as never);
    const response = await handle(request('/v1/records/lookup', { documentNumber: '123' }), {});
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('must-not-leak');
  });
});
it('returns shared 429 with Retry-After before loading tenant credentials', async () => {
  const context = vi.fn(async () => ok({ organizationId: claims.org_id }));
  const rate = { limit: vi.fn(async () => ({ success: false })) };
  const guarded = {
    ...manifest,
    tokens: { issuer: 'https://issuer.example.test/', audience: manifest.tokens.audience },
    context,
    telemetry: undefined,
    rateLimit: { binding: 'LIMIT' as const, retryAfter: 12 },
  };
  const handle = createHttpHandler<
    { LIMIT: typeof rate },
    { organizationId: string },
    typeof manifest.operations
  >(guarded, { verify: async () => claims });
  const response = await handle(request('/v1/records/lookup', { documentNumber: '123' }), { LIMIT: rate });
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('12');
  expect(context).not.toHaveBeenCalled();
});
it('bounds bodies and keeps unauthenticated requests out of business execution', async () => {
  const context = vi.fn(manifest.context);
  const handle = createHttpHandler(
    { ...manifest, context, maxBodyBytes: 40 },
    { verify: async () => claims }
  );
  const missing = await handle(request('/v1/records/lookup', { documentNumber: '123' }, ''), {});
  expect(missing.status).toBe(401);
  const oversized = await handle(request('/v1/records/lookup', { documentNumber: 'x'.repeat(100) }), {});
  expect(oversized.status).toBe(413);
  expect(oversized.headers.get('x-request-id')).toBeTruthy();
  expect(context).not.toHaveBeenCalled();
});
it('MCP discovery hides ungranted operations and failures never become empty success', async () => {
  const handle = createHttpHandler(manifest, { verify: async () => ({ ...claims, scope: 'test:mcp:use' }) });
  const response = await handle(
    request('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    {}
  );
  const text = await response.text();
  expect(JSON.parse(/data: (\{[^\n]*)/.exec(text)?.[1] ?? text).result.tools).toEqual([]);
});

it('validates business input and output once through the shared operation boundary', async () => {
  let inputs = 0;
  let outputs = 0;
  FormatRegistry.Set('count-input', () => {
    inputs += 1;
    return true;
  });
  FormatRegistry.Set('count-output', () => {
    outputs += 1;
    return true;
  });
  try {
    const app = {
      ...manifest,
      operations: {
        lookup: {
          ...manifest.operations.lookup,
          input: t.Object(
            { documentNumber: t.String({ format: 'count-input' }) },
            { additionalProperties: false }
          ),
          output: t.Object(
            { documentNumber: t.String({ format: 'count-output' }), organization: t.String() },
            { additionalProperties: false }
          ),
        },
      },
    };
    const handle = createHttpHandler(app, { verify: async () => claims });
    const response = await handle(
      request('/mcp', {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'lookup_record', arguments: { documentNumber: '123' } },
      }),
      {}
    );
    expect(await response.text()).toContain('structuredContent');
    expect({ inputs, outputs }).toEqual({ inputs: 1, outputs: 1 });
  } finally {
    FormatRegistry.Delete('count-input');
    FormatRegistry.Delete('count-output');
  }
});

it('keeps MCP input, output and hidden-tool checks after delegating business validation', async () => {
  const handle = createHttpHandler(manifest, { verify: async () => claims });
  const call = (args: unknown) =>
    request('/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'lookup_record', arguments: args },
    });
  execute.mockClear();
  expect(
    await (await handle(call({ documentNumber: '123', organizationId: 'private' }), {})).text()
  ).toContain('isError');
  expect(execute).not.toHaveBeenCalled();
  execute.mockResolvedValueOnce(
    ok({ documentNumber: '123', organization: claims.org_id, secret: 'OUTPUT_SENTINEL' }) as never
  );
  const invalid = await (await handle(call({ documentNumber: '123' }), {})).text();
  expect(invalid).toContain('isError');
  expect(invalid).not.toContain('OUTPUT_SENTINEL');
  const hidden = createHttpHandler(manifest, { verify: async () => ({ ...claims, scope: 'test:mcp:use' }) });
  execute.mockClear();
  expect(await (await hidden(call({ documentNumber: '123' }), {})).text()).toContain('Tool not found');
  expect(execute).not.toHaveBeenCalled();
});
