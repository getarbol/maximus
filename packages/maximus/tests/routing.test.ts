/**
 * HTTP routing: transport and plain route ownership of paths, ambiguous templates, typed GET queries, and
 * the verified access token an operation receives.
 */
import { expect, it, vi } from 'vite-plus/test';

import type { HttpTransport } from '../src/http.ts';
import { createHttpHandler, defineErrors, maximus, ok, t } from '../src/index.ts';
import type { Static } from '../src/index.ts';

const base = maximus<Record<string, never>>({
  name: 'routing',
  namespace: 'routing',
  title: 'Routing',
  version: '1',
  origin: 'https://example.test',
  tokens: { issuer: 'https://issuer.example.test/', audience: 'routing' },
  errors: defineErrors({}),
  rpc: { callers: [] },
});
const schema = t.Object({}, { additionalProperties: false });
const definition = {
  scope: 'routing:records:read',
  title: 'Read records',
  description: 'Read records.',
  effect: 'read' as const,
  input: schema,
  output: schema,
  http: { method: 'GET' as const, path: '/v1/records' },
};
function transport(path: string): HttpTransport {
  return { path, scope: () => 'routing:mcp:use', handle: async () => new Response('transport') };
}
it('rejects transport ownership of an operation pathname regardless of its HTTP method', () => {
  for (const method of ['GET', 'POST'] as const) {
    const app = base
      .operation('readRecords', { ...definition, http: { method, path: '/v1/records' } }, async () => ok({}))
      .build();
    expect(() => createHttpHandler(app, { transports: [transport('/v1/records')] })).toThrow('reserved');
  }
});
it('reserves every native pathname against transports', () => {
  for (const path of [
    '/',
    '/health',
    '/openapi.json',
    '/openapi.yaml',
    '/openapi.yml',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
  ]) {
    expect(() => createHttpHandler(base.build(), { transports: [transport(path)] })).toThrow('reserved');
  }
});
it('rejects ambiguous declaration paths without normalizing incoming paths', async () => {
  for (const path of ['/v1/records/', '/v1//records']) {
    expect(() =>
      base
        .operation('readRecords', { ...definition, http: { method: 'GET', path } }, async () => ok({}))
        .build()
    ).toThrow('fixed routes');
  }
  const verify = vi.fn();
  const handle = createHttpHandler(base.operation('readRecords', definition, async () => ok({})).build(), {
    verify,
  });
  for (const [method, path] of [
    ['POST', '/v1/records'],
    ['GET', '/v1/records/'],
  ]) {
    expect((await handle(new Request(`https://example.test${path}`, { method }), {})).status).toBe(404);
  }
  expect(verify).not.toHaveBeenCalled();
});

it('decodes every path segment before it routes, so an encoded fixed segment never reaches a parameter route', async () => {
  const strict = { additionalProperties: false } as const;
  const archive = vi.fn(async () => ok({ archived: true }));
  const read = vi.fn(async (_context: unknown, input: { recordId: string }) =>
    ok({ recordId: input.recordId })
  );
  const app = base
    .operation(
      'archiveRecords',
      {
        ...definition,
        scope: 'routing:records:write',
        effect: 'write',
        output: t.Object({ archived: t.Boolean() }, strict),
        http: { method: 'POST', path: '/v1/records/archive' },
      },
      archive
    )
    .operation(
      'readRecord',
      {
        ...definition,
        scope: 'routing:records:write',
        effect: 'write',
        input: t.Object({ recordId: t.String() }, strict),
        output: t.Object({ recordId: t.String() }, strict),
        http: { method: 'POST', path: '/v1/records/{recordId}' },
      },
      read
    )
    .build();
  const handle = createHttpHandler(app, {
    verify: async () => ({
      sub: 'person',
      azp: 'portal',
      org_id: 'org_1234567890abcdef',
      scope: 'routing:records:write',
      permissions: ['routing:records:write'],
    }),
  });
  const call = (path: string) =>
    handle(
      new Request(`https://example.test${path}`, {
        method: 'POST',
        headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json' },
        body: '{}',
      }),
      {}
    );
  const data = async (path: string) => ((await (await call(path)).json()) as { data: unknown }).data;
  // %61 is "a": the path is /v1/records/archive, whatever its spelling.
  expect(await data('/v1/records/%61rchive')).toEqual({ archived: true });
  expect(read).not.toHaveBeenCalled();
  // A parameter is decoded once, and a value that would change the path's segments is refused.
  expect(await data('/v1/records/a%20b')).toEqual({ recordId: 'a b' });
  for (const path of [
    '/v1/records/a%2Fb',
    '/v1/records/%2E%2E',
    '/v1/records/%E0%A4%A',
    '/v1/%72ecords//x',
  ]) {
    expect((await call(path)).status, path).toBe(404);
  }
});

it('refuses a JSON body or a query that names __proto__, which no input declares', async () => {
  const strict = { additionalProperties: false } as const;
  const app = base
    .operation(
      'searchRecords',
      {
        ...definition,
        input: t.Object({ term: t.Optional(t.String()), tags: t.Optional(t.Array(t.String())) }, strict),
        output: t.Object({ count: t.Integer() }, strict),
      },
      async () => ok({ count: 0 })
    )
    .operation(
      'createRecord',
      {
        ...definition,
        scope: 'routing:records:write',
        effect: 'write',
        input: t.Object({ title: t.String() }, strict),
        output: t.Object({ count: t.Integer() }, strict),
        http: { method: 'POST', path: '/v1/records' },
      },
      async () => ok({ count: 1 })
    )
    .build();
  const handle = createHttpHandler(app, {
    verify: async () => ({
      sub: 'person',
      azp: 'portal',
      org_id: 'org_1234567890abcdef',
      scope: 'routing:records:read routing:records:write',
      permissions: ['routing:records:read', 'routing:records:write'],
    }),
  });
  const headers = { authorization: 'Bearer a.b.c', 'content-type': 'application/json' };
  for (const query of ['?__proto__=x', '?__proto__=a,b', '?term=x&__proto__=y']) {
    const response = await handle(new Request(`https://example.test/v1/records${query}`, { headers }), {});
    expect(response.status, query).toBe(400);
  }
  const posted = await handle(
    new Request('https://example.test/v1/records', {
      method: 'POST',
      headers,
      body: '{"title":"x","__proto__":{"archived":true}}',
    }),
    {}
  );
  expect(posted.status).toBe(400);
  expect(await posted.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
});

it('serves an explicit route beneath a transport path while the transport keeps its exact path', async () => {
  const app = base.build();
  expect(() =>
    createHttpHandler(app, {
      transports: [transport('/mcp')],
      routes: { '/mcp': async () => new Response('route') },
    })
  ).toThrow('reserved');
  const handle = createHttpHandler(app, {
    transports: [transport('/mcp')],
    routes: { '/mcp/agent-runtime': async () => new Response('agent runtime') },
    verify: async () => {
      throw new Error('unused');
    },
  });
  const nested = await handle(new Request('https://example.test/mcp/agent-runtime', { method: 'POST' }), {});
  expect(await nested.text()).toBe('agent runtime');
  const unlisted = await handle(new Request('https://example.test/mcp/other', { method: 'POST' }), {});
  expect(unlisted.status).toBe(404);
});

it('reads a GET query field as its declared kind, as generated clients write it', async () => {
  const query = t.Object(
    {
      limit: t.Integer(),
      active: t.Optional(t.Boolean()),
      tags: t.Optional(t.Array(t.String())),
      name: t.Optional(t.String()),
    },
    { additionalProperties: false }
  );
  const app = base
    .operation('findRecords', { ...definition, input: query, output: query }, async ({ input }) =>
      ok(input as Static<typeof query>)
    )
    .build();
  const handle = createHttpHandler(app, {
    verify: async () => ({
      sub: 'person',
      azp: 'portal',
      org_id: 'org_1234567890abcdef',
      scope: 'routing:records:read',
      permissions: ['routing:records:read'],
    }),
  });
  const get = async (search: string) =>
    handle(
      new Request(`https://example.test/v1/records${search}`, { headers: { authorization: 'Bearer a.b.c' } }),
      {}
    );
  const found = await get('?limit=2&active=true&tags=a,b&name=7');
  expect(found.status).toBe(200);
  expect(((await found.json()) as { data: unknown }).data).toEqual({
    limit: 2,
    active: true,
    tags: ['a', 'b'],
    name: '7',
  });
  for (const search of ['?limit=two', '?limit=1&limit=2', '?limit=1&active=yes', '?limit=1&tags=a,,b']) {
    expect((await get(search)).status).toBe(400);
  }
});

it('hands an operation the verified access token, to call another service as the same caller', async () => {
  const echo = t.Object({ token: t.String() }, { additionalProperties: false });
  const app = base
    .operation('readRecords', { ...definition, output: echo }, async ({ authority }) =>
      ok({ token: authority?.token ?? '' })
    )
    .build();
  const handle = createHttpHandler(app, {
    verify: async () => ({
      sub: 'person',
      azp: 'portal',
      org_id: 'org_1234567890abcdef',
      scope: 'routing:records:read',
      permissions: ['routing:records:read'],
    }),
  });
  const response = await handle(
    new Request('https://example.test/v1/records', { headers: { authorization: 'Bearer a.b.c' } }),
    {}
  );
  expect(((await response.json()) as { data: unknown }).data).toEqual({ token: 'a.b.c' });
});
