/**
 * How the handler composes the application with the rest of a Worker: a base path and a health path,
 * plain routes, prefix mounts, transports, the `before` hook and the fallback, and every path claim and
 * token scheme that construction refuses.
 */
import { expect, it, vi } from 'vite-plus/test';

import type { HttpOptions, HttpRoute, HttpTransport } from '../../src/http.ts';
import { createHttpHandler, defineErrors, err, maximus, ok, standardErrors, t } from '../../src/index.ts';
import type { McpConfiguration, TokenPolicy } from '../../src/index.ts';

const ISSUER = 'https://issuer.example.test/';
const ORIGIN = 'https://records.example.test';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const empty = t.Object({}, { additionalProperties: false });
/** A machine client of the organization that may read records and use the tools endpoint. */
const claims = {
  sub: 'client@clients',
  client_id: 'client',
  org_id: 'org_1234567890abcdef',
  scope: 'records:records:read records:tools:use',
};
const authorized = { headers: { authorization: 'Bearer a.b.c' } };

/** The handler's bindings: none. */
type Env = Record<string, never>;

/** A records service with one public route, under the token policy and MCP configuration given. */
function application(tokens: Partial<TokenPolicy<Env>> = {}, mcp?: McpConfiguration) {
  return maximus<Env>({
    name: 'records',
    namespace: 'records',
    title: 'Records',
    version: '1',
    origin: ORIGIN,
    tokens: { issuer: ISSUER, audience: ORIGIN, ...tokens },
    errors: defineErrors({}),
    rpc: { callers: [] },
    telemetry: { enabled: false },
    ...(mcp ? { mcp } : {}),
  })
    .operation(
      'listRecords',
      {
        scope: 'records:records:read',
        title: 'List records',
        description: 'List the organization records.',
        effect: 'read',
        input: empty,
        output: empty,
        http: { method: 'GET', path: '/v1/records' },
        // Under dual authentication, an operation names the actors it admits.
        ...(tokens.scheme?.type === 'oauth+bearer' ? { actorKinds: ['user', 'service'] as const } : {}),
      },
      async () => ok({})
    )
    .build();
}

/** A protocol endpoint beside the operations, answering every admitted request with its name. */
function transport(path: string, protocol?: 'mcp'): HttpTransport {
  return {
    ...(protocol ? { protocol } : {}),
    path,
    scope: (namespace) => `${namespace}:tools:use`,
    handle: async () => new Response('transport'),
  };
}

/** A plain route or mount that answers with its name and the path it received. */
function answering(name: string, headers?: HeadersInit): HttpRoute<Env> {
  return async (request) => Response.json({ name, path: new URL(request.url).pathname }, { headers });
}

/** The name of the plain route, mount or fallback that answered. */
async function answeredBy(response: Response) {
  return ((await response.json()) as { name: string }).name;
}

it('serves operations and discovery below a base path while transports, routes and mounts stay absolute', async () => {
  const fallback = vi.fn(answering('fallback', { 'cache-control': 'no-cache' }));
  const handle = createHttpHandler(application(), {
    basePath: '/api',
    verify: async () => claims,
    transports: [transport('/tools')],
    routes: { '/hooks/payments': answering('payments') },
    mounts: { '/files': answering('files') },
    fallback,
  });
  const get = (path: string, init?: RequestInit) => handle(new Request(`${ORIGIN}${path}`, init), {});
  expect(await (await get('/api')).json()).toStrictEqual({ name: 'Records', openapi: '/api/openapi.json' });
  const document = (await (await get('/api/openapi.json')).json()) as { servers: unknown };
  expect(document.servers).toEqual([{ url: `${ORIGIN}/api` }]);
  expect(await (await get('/api/health')).json()).toMatchObject({ status: 'ok' });
  expect((await get('/api/v1/records', authorized)).status).toBe(200);
  expect(await answeredBy(await get('/hooks/payments', { method: 'POST' }))).toBe('payments');
  expect(await answeredBy(await get('/files/2026/report.pdf'))).toBe('files');
  expect(await (await get('/tools', { method: 'POST', ...authorized })).text()).toBe('transport');
  // Outside the base path, the native names are free: the web app answers them, with its own caching.
  const page = await get('/');
  expect(await answeredBy(page)).toBe('fallback');
  expect(page.headers.get('cache-control')).toBe('no-cache');
  expect(await answeredBy(await get('/openapi.json'))).toBe('fallback');
  // A miss in the versioned, base, discovery or transport namespace stays a native 404.
  for (const path of [
    '/v1/records',
    '/api/unknown',
    '/api/v1',
    '/.well-known/security.txt',
    '/tools/admin',
  ]) {
    const response = await get(path, authorized);
    expect(response.status, path).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  }
  expect(fallback).toHaveBeenCalledTimes(2);
});

it('treats a base path of / as the root', async () => {
  const handle = createHttpHandler(application(), { basePath: '/' });
  expect(await (await handle(new Request(`${ORIGIN}/`), {})).json()).toStrictEqual({
    name: 'Records',
    openapi: '/openapi.json',
  });
  const document = (await (await handle(new Request(`${ORIGIN}/openapi.json`), {})).json()) as {
    servers: unknown;
  };
  expect(document.servers).toEqual([{ url: ORIGIN }]);
});

it('refuses a base path that is relative, ends in a slash or has empty or dot segments', () => {
  for (const basePath of ['api', '/api/', '/api/../admin', '/api/./v', '/api//v', '/a b']) {
    expect(() => createHttpHandler(application(), { basePath }), basePath).toThrow(
      'HTTP basePath must be an absolute path without a trailing slash or dot segments.'
    );
  }
});

it('moves liveness to an absolute health path, leaving the default one a native 404', async () => {
  const handle = createHttpHandler(application(), { basePath: '/api', healthPath: '/healthz' });
  expect(await (await handle(new Request(`${ORIGIN}/healthz`), {})).json()).toStrictEqual({
    status: 'ok',
    service: 'records',
    version: '1',
  });
  expect((await handle(new Request(`${ORIGIN}/api/health`), {})).status).toBe(404);
  // Naming the default health path explicitly is no conflict.
  expect(() =>
    createHttpHandler(application(), { basePath: '/api', healthPath: '/api/health' })
  ).not.toThrow();
});

it('refuses a health path that is malformed, versioned or another native path', () => {
  for (const [basePath, healthPath] of [
    [undefined, 'healthz'],
    [undefined, '/healthz/'],
    [undefined, '/openapi.json'],
    [undefined, '/v1/health'],
    ['/api', '/api/openapi.yaml'],
    ['/api', '/api/v2/health'],
  ]) {
    expect(() => createHttpHandler(application(), { basePath, healthPath }), healthPath).toThrow(
      'HTTP healthPath must be an unreserved absolute path.'
    );
  }
});

it('refuses OAuth resources outside the protected-resource namespace or at the health path', () => {
  const resource = { audience: ORIGIN, authorizationServers: [ISSUER], scopes: ['records:records:read'] };
  for (const [path, healthPath] of [
    ['/oauth/metadata', undefined],
    ['/.well-known/oauth-protected-resource/', undefined],
    ['/.well-known/oauth-protected-resource-api', undefined],
    ['/.well-known/oauth-protected-resource/status', '/.well-known/oauth-protected-resource/status'],
  ] as const) {
    const app = application({ resources: { [path]: resource }, resourceMetadataUrl: `${ORIGIN}${path}` });
    expect(() => createHttpHandler(app, { healthPath }), path).toThrow(
      'OAuth resources require distinct absolute protected-resource discovery paths.'
    );
  }
  // A configured resource's path is reserved against plain routes.
  const path = '/.well-known/oauth-protected-resource/api';
  const app = application({ resources: { [path]: resource }, resourceMetadataUrl: `${ORIGIN}${path}` });
  expect(() => createHttpHandler(app, { routes: { [path]: answering('metadata') } })).toThrow(
    `Route path is reserved or malformed: ${path}`
  );
});

it('refuses two MCP transports, MCP configuration without one, and transports at one path or nested', () => {
  const app = application();
  expect(() =>
    createHttpHandler(app, { transports: [transport('/agents', 'mcp'), transport('/mcp')] })
  ).toThrow('An HTTP handler may mount only one MCP transport.');
  expect(() => createHttpHandler(application({}, {}))).toThrow(
    'MCP configuration requires the optional MCP transport.'
  );
  expect(() => createHttpHandler(app, { transports: [transport('/tools'), transport('/tools')] })).toThrow(
    'Duplicate transport path.'
  );
  expect(() =>
    createHttpHandler(app, { transports: [transport('/tools'), transport('/tools/admin')] })
  ).toThrow('Transport path is reserved: /tools');
});

it('refuses a token scheme the handler could never serve', () => {
  const resolve = async () => err(standardErrors.unauthorized.create());
  const bearer = { type: 'bearer' as const, description: 'A visitor session.' };
  expect(() => createHttpHandler(application({ scheme: bearer, resolve, resources: {} }))).toThrow(
    'A bearer token scheme cannot publish OAuth resource discovery.'
  );
  for (const scheme of [bearer, { type: 'oauth+bearer' as const, description: 'A workload key.' }]) {
    expect(() => createHttpHandler(application({ scheme })), scheme.type).toThrow(
      'An application bearer token scheme requires tokens.resolve to verify the token.'
    );
  }
  expect(() =>
    createHttpHandler(application({ scheme: bearer, resolve }), { transports: [transport('/mcp')] })
  ).toThrow('The MCP transport needs OAuth discovery; it cannot serve a bearer token scheme.');
});

it('routes a prefix mount and every descendant to the longest mounted prefix, outside token admission', async () => {
  const verify = vi.fn(async () => claims);
  const handle = createHttpHandler(application(), {
    verify,
    mounts: {
      '/files': answering('files', { 'cache-control': 'private, max-age=300' }),
      '/files/archive': answering('archive'),
    },
    fallback: answering('fallback'),
  });
  const put = (path: string) => handle(new Request(`${ORIGIN}${path}`, { method: 'PUT' }), {});
  const files = await put('/files');
  expect(await answeredBy(files)).toBe('files');
  // A mount chooses its own caching; the request id and nosniff still apply.
  expect(files.headers.get('cache-control')).toBe('private, max-age=300');
  expect(files.headers.get('x-request-id')).toMatch(UUID);
  expect(files.headers.get('x-content-type-options')).toBe('nosniff');
  expect(await answeredBy(await put('/files/2026/report.pdf'))).toBe('files');
  expect(await answeredBy(await put('/files/archive'))).toBe('archive');
  expect(await answeredBy(await put('/files/archive/2025/report.pdf'))).toBe('archive');
  expect(await answeredBy(await put('/files-extra'))).toBe('fallback');
  expect(verify).not.toHaveBeenCalled();
});

it('refuses a mount that is malformed, versioned, or overlaps a native path, a transport or a route', () => {
  const payments = { '/hooks/payments': answering('payments') };
  const cases: [string, HttpOptions<Env>][] = [
    ['/files/', {}],
    ['/v2', {}],
    ['/.well-known', {}],
    ['/health', {}],
    ['/api', { basePath: '/api' }],
    ['/api/v1', { basePath: '/api' }],
    ['/tools', { transports: [transport('/tools')] }],
    ['/tools/admin', { transports: [transport('/tools')] }],
    ['/hooks', { routes: payments }],
    ['/hooks/payments/retries', { routes: payments }],
  ];
  for (const [prefix, options] of cases) {
    expect(
      () => createHttpHandler(application(), { ...options, mounts: { [prefix]: answering('mount') } }),
      prefix
    ).toThrow(`Mount path is reserved or malformed: ${prefix}`);
  }
});

it('refuses a plain route at a malformed, versioned, native or transport path, also below a base path', () => {
  const cases: [string, HttpOptions<Env>][] = [
    ['/webhooks/', {}],
    ['/v1/webhooks', {}],
    ['/openapi.yaml', {}],
    ['/api/v1/webhooks', { basePath: '/api' }],
    ['/api/health', { basePath: '/api' }],
    ['/tools', { transports: [transport('/tools')] }],
  ];
  for (const [path, options] of cases) {
    expect(
      () => createHttpHandler(application(), { ...options, routes: { [path]: answering('route') } }),
      path
    ).toThrow(`Route path is reserved or malformed: ${path}`);
  }
});

it('runs the before hook ahead of every route and token, and continues when it answers null', async () => {
  const verify = vi.fn(async () => claims);
  const before = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    return url.hostname === 'www.records.example.test'
      ? new Response(null, {
          status: 308,
          headers: { location: `${ORIGIN}${url.pathname}`, 'cache-control': 'public, max-age=3600' },
        })
      : null;
  });
  const handle = createHttpHandler(application(), {
    before,
    verify,
    routes: { '/hooks/payments': answering('payments') },
  });
  const redirected = await handle(new Request('https://www.records.example.test/v1/records', authorized), {});
  expect(redirected.status).toBe(308);
  expect(redirected.headers.get('location')).toBe(`${ORIGIN}/v1/records`);
  // The hook chooses its own caching, like a plain route; the request id still applies.
  expect(redirected.headers.get('cache-control')).toBe('public, max-age=3600');
  expect(redirected.headers.get('x-request-id')).toMatch(UUID);
  expect(verify).not.toHaveBeenCalled();
  expect((await handle(new Request(`${ORIGIN}/v1/records`, authorized), {})).status).toBe(200);
  const route = await handle(new Request(`${ORIGIN}/hooks/payments`, { method: 'POST' }), {});
  expect(await answeredBy(route)).toBe('payments');
  expect(route.headers.get('cache-control')).toBe('private, no-store');
  expect(before).toHaveBeenCalledTimes(3);
});
