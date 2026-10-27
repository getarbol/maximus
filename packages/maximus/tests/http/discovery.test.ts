/**
 * The handler's own documents: its index, liveness and OpenAPI texts, the inferred and configured OAuth
 * protected-resource metadata (RFC 9728), and the 401 challenge that points clients at them.
 */
import { expect, it, vi } from 'vite-plus/test';
import { parse } from 'yaml';

import type { HttpTransport } from '../../src/http.ts';
import {
  createHttpHandler,
  defineErrors,
  err,
  maximus,
  ok,
  protectedResourceMetadata,
  standardErrors,
  t,
} from '../../src/index.ts';
import type {
  McpConfiguration,
  OAuthResource,
  TokenPolicy,
  TokenResolutionContext,
} from '../../src/index.ts';

const ISSUER = 'https://issuer.example.test/';
const ORIGIN = 'https://records.example.test';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const empty = t.Object({}, { additionalProperties: false });

/** The bindings a configured resource reads its audience and issuer from. */
interface Env {
  API_AUDIENCE?: string;
  API_ISSUER?: string;
}

/** A records service with one public route, under the token policy and MCP configuration given. */
function application(tokens: Partial<TokenPolicy<Env>> = {}, mcp?: McpConfiguration) {
  return maximus<Env>({
    name: 'records',
    namespace: 'records',
    title: 'Records',
    version: '3',
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
    scope: (namespace) => `${namespace}:mcp:use`,
    handle: async () => new Response('transport'),
  };
}

/** A resource that names its audience and issuer from the env, as a deployment configures it. */
const resource: OAuthResource<Env> = {
  audience: (env) => env.API_AUDIENCE ?? '',
  authorizationServers: (env) => [env.API_ISSUER ?? '', env.API_ISSUER ?? ''],
  scopes: ['openid', 'records:records:read', 'openid'],
};

/** The challenge a request without a token receives at `path`. */
async function challenge(handle: (request: Request, env: Env) => Promise<Response>, path = '/v1/records') {
  const response = await handle(new Request(`${ORIGIN}${path}`, { method: 'GET' }), {});
  expect(response.status, path).toBe(401);
  return response.headers.get('www-authenticate');
}

it('answers its index, liveness and OpenAPI documents without reading a token', async () => {
  const verify = vi.fn();
  const handle = createHttpHandler(application(), { verify });
  const index = await handle(new Request(`${ORIGIN}/`), {});
  expect(await index.json()).toStrictEqual({ name: 'Records', openapi: '/openapi.json' });
  const health = await handle(new Request(`${ORIGIN}/health`), {});
  expect(await health.json()).toStrictEqual({ status: 'ok', service: 'records', version: '3' });
  const json = await (await handle(new Request(`${ORIGIN}/openapi.json`), {})).json();
  const yaml = await handle(new Request(`${ORIGIN}/openapi.yml`), {});
  expect(yaml.headers.get('content-type')).toBe('application/yaml; charset=utf-8');
  expect(parse(await yaml.text())).toStrictEqual(json);
  for (const response of [index, health, yaml]) {
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-request-id')).toMatch(UUID);
    expect(response.headers.get('server-timing')).toMatch(/^total;dur=\d+\.\d$/);
  }
  expect(verify).not.toHaveBeenCalled();
});

it('names the MCP endpoint in its index only when the application configures MCP', async () => {
  const configured = createHttpHandler(application({}, {}), { transports: [transport('/agents', 'mcp')] });
  expect(await (await configured(new Request(`${ORIGIN}/`), {})).json()).toStrictEqual({
    name: 'Records',
    openapi: '/openapi.json',
    mcp: '/agents',
  });
  const unconfigured = createHttpHandler(application(), { transports: [transport('/mcp')] });
  expect(await (await unconfigured(new Request(`${ORIGIN}/`), {})).json()).toStrictEqual({
    name: 'Records',
    openapi: '/openapi.json',
  });
});

it('refuses any method but GET at its liveness path, before reading a token', async () => {
  const verify = vi.fn();
  const handle = createHttpHandler(application(), { verify });
  const response = await handle(
    new Request(`${ORIGIN}/health`, { method: 'POST', headers: { authorization: 'Bearer a.b.c' } }),
    {}
  );
  expect(response.status).toBe(405);
  expect(response.headers.get('allow')).toBe('GET');
  expect(await response.json()).toStrictEqual({
    success: false,
    data: null,
    error: standardErrors.methodNotAllowed.create(),
    metadata: { requestId: response.headers.get('x-request-id') },
  });
  expect(verify).not.toHaveBeenCalled();
});

it('publishes the inferred protected-resource metadata, and none under its own bearer tokens or configured resources', async () => {
  const inferred = await createHttpHandler(application())(
    new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`),
    {}
  );
  expect(inferred.headers.get('access-control-allow-origin')).toBe('*');
  expect(await inferred.json()).toStrictEqual({
    resource: ORIGIN,
    resource_name: 'Records',
    authorization_servers: [ISSUER],
    bearer_methods_supported: ['header'],
    scopes_supported: ['records:records:read'],
    resource_documentation: `${ORIGIN}/openapi.json`,
  });
  const ownBearer = application({
    scheme: { type: 'bearer', description: 'A visitor session.' },
    resolve: async () => err(standardErrors.unauthorized.create()),
  });
  const configured = application({
    resources: { '/.well-known/oauth-protected-resource/api': resource },
    resourceMetadataUrl: `${ORIGIN}/.well-known/oauth-protected-resource/api`,
  });
  for (const app of [ownBearer, configured]) {
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const response = await createHttpHandler(app)(new Request(`${ORIGIN}${path}`), {});
      expect(response.status, path).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
  }
});

it('serves each configured resource from its env, deduplicated, and only to GET', async () => {
  const path = '/.well-known/oauth-protected-resource/api';
  const handle = createHttpHandler(
    application({ resources: { [path]: resource }, resourceMetadataUrl: `${ORIGIN}${path}` })
  );
  const env = { API_AUDIENCE: 'https://api.example.test', API_ISSUER: ISSUER };
  const response = await handle(new Request(`${ORIGIN}${path}`), env);
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
  expect(await response.json()).toStrictEqual({
    resource: 'https://api.example.test',
    authorization_servers: [ISSUER],
    bearer_methods_supported: ['header'],
    scopes_supported: ['openid', 'records:records:read'],
  });
  const posted = await handle(new Request(`${ORIGIN}${path}`, { method: 'POST' }), env);
  expect(posted.status).toBe(405);
  expect(posted.headers.get('allow')).toBe('GET');
  // A deployment missing a binding fails closed instead of publishing a partial document.
  const unbound = await handle(new Request(`${ORIGIN}${path}`), {});
  expect(unbound.status).toBe(500);
  expect(await unbound.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
});

it('refuses to publish non-HTTPS or credentialed identifiers, an issuer with a query, and malformed scopes', () => {
  const valid = {
    audience: 'https://api.example.test/records?version=1',
    authorizationServers: [ISSUER],
    scopes: ['records:records:read'],
  };
  // An audience may carry a query; only an issuer identifier may not.
  expect(protectedResourceMetadata(valid, {})).toStrictEqual({
    resource: 'https://api.example.test/records?version=1',
    authorization_servers: [ISSUER],
    bearer_methods_supported: ['header'],
    scopes_supported: ['records:records:read'],
  });
  for (const invalid of [
    { ...valid, audience: 'http://api.example.test' },
    { ...valid, audience: 'https://reader@api.example.test' },
    { ...valid, audience: 'https://:secret@api.example.test' },
    { ...valid, audience: 'https://api.example.test#records' },
    { ...valid, audience: 'records' },
    { ...valid, authorizationServers: [] },
    { ...valid, authorizationServers: [`${ISSUER}?tenant=acme`] },
    { ...valid, scopes: ['records records:read'] },
    { ...valid, scopes: ['records"read'] },
    { ...valid, scopes: [String.raw`records\read`] },
    { ...valid, scopes: [''] },
  ]) {
    expect(() => protectedResourceMetadata(invalid, {})).toThrow(
      'OAuth discovery requires HTTPS resource and issuer identifiers and valid scopes.'
    );
  }
});

it('challenges a missing token toward the discovery the application publishes', async () => {
  expect(await challenge(createHttpHandler(application()))).toBe(
    `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`
  );
  expect(await challenge(createHttpHandler(application(), { basePath: '/api' }), '/api/v1/records')).toBe(
    `Bearer resource_metadata="${ORIGIN}/api/.well-known/oauth-protected-resource"`
  );
  expect(
    await challenge(
      createHttpHandler(application({ resourceMetadataUrl: 'https://docs.example.test/oauth' }))
    )
  ).toBe('Bearer resource_metadata="https://docs.example.test/oauth"');
  // No discovery to point at: a plain challenge.
  for (const tokens of [
    { resourceMetadataUrl: null },
    { resources: {} },
    {
      scheme: { type: 'bearer', description: 'A visitor session.' },
      resolve: async () => err(standardErrors.unauthorized.create()),
    },
  ] satisfies Partial<TokenPolicy<Env>>[]) {
    expect(await challenge(createHttpHandler(application(tokens)))).toBe('Bearer');
  }
});

it('lets the application choose the challenge per request', async () => {
  const seen: TokenResolutionContext<Env>[] = [];
  const choose = (context: TokenResolutionContext<Env>) => {
    seen.push(context);
    return context.surface === 'mcp' ? `${ORIGIN}/.well-known/oauth-protected-resource/mcp` : null;
  };
  const handle = createHttpHandler(application({ resourceMetadataUrl: choose }), {
    transports: [transport('/mcp')],
  });
  expect(await challenge(handle)).toBe('Bearer');
  expect(await challenge(handle, '/mcp')).toBe(
    `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`
  );
  expect(seen.map((context) => [context.surface, new URL(context.request.url).pathname])).toEqual([
    ['http', '/v1/records'],
    ['mcp', '/mcp'],
  ]);
  expect(seen[0]?.applicationScopes).toEqual(['records:records:read', 'records:mcp:use']);
});

it('challenges toward the default path, where a manifest assembled outside the builder keys its resource', async () => {
  const built = application();
  const handle = createHttpHandler({
    ...built,
    tokens: { ...built.tokens, resources: { '/.well-known/oauth-protected-resource': resource } },
  });
  expect(await challenge(handle)).toBe(
    `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`
  );
  const metadata = await handle(new Request(`${ORIGIN}/.well-known/oauth-protected-resource`), {
    API_AUDIENCE: ORIGIN,
    API_ISSUER: ISSUER,
  });
  expect(await metadata.json()).toMatchObject({ resource: ORIGIN, authorization_servers: [ISSUER] });
});
