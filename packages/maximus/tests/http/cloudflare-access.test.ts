/**
 * The HTTP handler behind Cloudflare Access: callers admitted by the application token alone, a plain
 * challenge and no OAuth discovery, no token passed on to operations, the development token still accepted
 * from localhost, writes a browser sends for another site refused, the Access service token's headers in
 * OpenAPI, and no MCP transport.
 */
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vite-plus/test';

import { createHttpHandler, defineErrors, maximus, ok, t } from '../../src/index.ts';
import type { TokenPolicy } from '../../src/index.ts';
import { mcp } from '../../src/mcp/index.ts';

/** The application's origin, which Access protects. */
const ORIGIN = 'https://notes.example.test';
/** The team's domain, Access's issuer. */
const TEAM = 'https://acme.cloudflareaccess.com';
/** The Access application's AUD tag. */
const AUD = '4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2';
/** The organization of the application's one tenant. */
const ORG = 'org_1234567890abcdef';
/** The client id of the service token the policy grants a read. */
const SERVICE = '88bf3b6d86161464f6509f7219099e57.access';
/** A person as Access names them. */
const PERSON = { type: 'app', sub: '7335d417-61da-459d-899c-0a01c76a2f94', email: 'ana@example.com' };
/** A development token as `.dev.vars` would hold it: at least 32 characters. */
const DEVELOPMENT_TOKEN = 'local-development-token-0123456789';

/** The bindings the development token is read from. */
interface Env {
  DEVELOPMENT_TOKEN?: string;
}

/** An application of one tenant behind Access: its people read and write notes, and one service reads. */
const POLICY: TokenPolicy<Env> = {
  source: 'cloudflare-access',
  issuer: TEAM,
  jwksUri: `${TEAM}/cdn-cgi/access/certs`,
  audience: [AUD],
  algorithms: ['RS256'],
  access: {
    organizationId: ORG,
    people: ['notes:notes:read', 'notes:notes:write'],
    services: { [SERVICE]: ['notes:notes:read'] },
  },
};

/** What the operations answer: who called, and the authority the call carries. */
const Caller = t.Object(
  {
    actorId: t.String(),
    actorKind: t.String(),
    organizationId: t.String(),
    client: t.Union([t.String(), t.Null()]),
    token: t.Union([t.String(), t.Null()]),
  },
  { additionalProperties: false }
);
/** The input of every operation: nothing. */
const empty = t.Object({}, { additionalProperties: false });

/** A notes service behind Access with a read and a write, both answering who called. */
function application(tokens: TokenPolicy<Env> = POLICY) {
  /** Answers the caller and the authority of the call. */
  const whoCalled = async (context: {
    principal: { actorId: string; actorKind: string; organizationId: string };
    authority?: { client: { id: string }; token?: string };
  }) =>
    ok({
      actorId: context.principal.actorId,
      actorKind: context.principal.actorKind,
      organizationId: context.principal.organizationId,
      client: context.authority?.client.id ?? null,
      token: context.authority?.token ?? null,
    });
  return maximus<Env>({
    name: 'notes',
    namespace: 'notes',
    title: 'Notes',
    version: '1',
    origin: ORIGIN,
    tokens,
    errors: defineErrors({}),
    rpc: { callers: [] },
    telemetry: { enabled: false },
  })
    .operation(
      'listNotes',
      {
        scope: 'notes:notes:read',
        title: 'List notes',
        description: 'List the organization notes.',
        effect: 'read',
        input: empty,
        output: Caller,
        http: { method: 'GET', path: '/v1/notes' },
      },
      whoCalled
    )
    .operation(
      'createNote',
      {
        scope: 'notes:notes:write',
        title: 'Create a note',
        description: 'Create a note in the organization.',
        effect: 'write',
        input: empty,
        output: Caller,
        http: { method: 'POST', path: '/v1/notes' },
      },
      whoCalled
    )
    .build();
}

/** The team's signing key pair, whose public key the mocked JWKS serves. */
let team: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => {
  team = await generateKeyPair('RS256', { extractable: true });
});
beforeEach(async () => {
  const jwk = await exportJWK(team.publicKey);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    Response.json({ keys: [{ ...jwk, kid: 'access-1', alg: 'RS256', use: 'sig' }] })
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** An application token Access signs for the application. */
function accessToken(claims: Record<string, unknown>) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'access-1', typ: 'JWT' })
    .setIssuer(TEAM)
    .setAudience([AUD])
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(team.privateKey);
}

/** A request to the API with these headers; a write sends an empty JSON body. */
function request(method: 'GET' | 'POST', headers: Record<string, string> = {}, origin = ORIGIN) {
  return new Request(`${origin}/v1/notes`, {
    method,
    headers: method === 'POST' ? { 'content-type': 'application/json', ...headers } : headers,
    ...(method === 'POST' ? { body: '{}' } : {}),
  });
}

it('admits a person and a service token by the application token, and passes no token on', async () => {
  const handle = createHttpHandler(application());
  const person = await handle(
    request('POST', {
      'cf-access-jwt-assertion': await accessToken(PERSON),
      // A bearer token beside it is neither verified nor passed on.
      authorization: 'Bearer unverified.bearer.token',
    }),
    {}
  );
  expect(person.status).toBe(200);
  expect(((await person.json()) as { data: unknown }).data).toStrictEqual({
    actorId: PERSON.sub,
    actorKind: 'user',
    organizationId: ORG,
    client: AUD,
    token: null,
  });
  const service = await handle(
    request('GET', {
      'cf-access-jwt-assertion': await accessToken({ type: 'app', sub: '', common_name: SERVICE }),
    }),
    {}
  );
  expect(((await service.json()) as { data: unknown }).data).toMatchObject({
    actorId: SERVICE,
    actorKind: 'service',
    client: SERVICE,
    token: null,
  });
});

it('refuses with 403 a scoped route to a service token the policy grants nothing', async () => {
  const unknown = await accessToken({ type: 'app', sub: '', common_name: 'f0f0f0f0f0f0f0f0.access' });
  const response = await createHttpHandler(application())(
    request('GET', { 'cf-access-jwt-assertion': unknown }),
    {}
  );
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
});

it('challenges a request without the Access header plainly, and serves no OAuth discovery', async () => {
  const handle = createHttpHandler(application());
  const token = await accessToken(PERSON);
  const withoutAccessHeader: Record<string, string>[] = [
    {},
    { authorization: `Bearer ${token}` },
    { cookie: `CF_Authorization=${token}` },
    { 'cf-access-authenticated-user-email': PERSON.email },
  ];
  for (const headers of withoutAccessHeader) {
    const response = await handle(request('GET', headers), {});
    expect(response.status, JSON.stringify(headers)).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
  }
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const response = await handle(new Request(`${ORIGIN}${path}`), {});
    expect(response.status, path).toBe(404);
  }
});

it('still admits the development token from localhost, and from nowhere else', async () => {
  const handle = createHttpHandler(application({ ...POLICY, development: { binding: 'DEVELOPMENT_TOKEN' } }));
  const env = { DEVELOPMENT_TOKEN };
  const local = await handle(
    request('GET', { authorization: `Bearer ${DEVELOPMENT_TOKEN}` }, 'http://localhost:5173'),
    env
  );
  expect(local.status).toBe(200);
  expect(((await local.json()) as { data: unknown }).data).toMatchObject({
    actorId: 'local-developer',
    organizationId: 'local-development',
  });
  const deployed = await handle(request('GET', { authorization: `Bearer ${DEVELOPMENT_TOKEN}` }), env);
  expect(deployed.status).toBe(401);
  // In the Access header, it is no Access token.
  const misplaced = await handle(
    request('GET', { 'cf-access-jwt-assertion': DEVELOPMENT_TOKEN }, 'http://localhost:5173'),
    env
  );
  expect(misplaced.status).toBe(401);
});

it('refuses a write a browser sends for another site, before reading its token', async () => {
  const handle = createHttpHandler(application());
  const token = await accessToken(PERSON);
  const crossSite: Record<string, string>[] = [
    { 'sec-fetch-site': 'cross-site' },
    { origin: 'https://attacker.example' },
    { origin: 'null' },
    { origin: 'https://notes.example.test.attacker.example' },
  ];
  for (const headers of crossSite) {
    const response = await handle(request('POST', { 'cf-access-jwt-assertion': token, ...headers }), {});
    expect(response.status, JSON.stringify(headers)).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  }
  // A read changes nothing, and the application's own pages may write.
  const read = await handle(
    request('GET', { 'cf-access-jwt-assertion': token, 'sec-fetch-site': 'cross-site' }),
    {}
  );
  expect(read.status).toBe(200);
  const sameOrigin: Record<string, string>[] = [
    { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
    { origin: ORIGIN },
    // A client that is no browser, such as a service token's, sends neither header.
    {},
  ];
  for (const headers of sameOrigin) {
    const write = await handle(request('POST', { 'cf-access-jwt-assertion': token, ...headers }), {});
    expect(write.status, JSON.stringify(headers)).toBe(200);
  }
});

it('documents the Access service token headers in OpenAPI', async () => {
  const response = await createHttpHandler(application())(new Request(`${ORIGIN}/openapi.json`), {});
  const document = (await response.json()) as {
    paths: Record<string, Record<string, { security: unknown }>>;
    components: { securitySchemes: unknown };
  };
  expect(document.components.securitySchemes).toStrictEqual({
    accessClientId: {
      type: 'apiKey',
      in: 'header',
      name: 'CF-Access-Client-Id',
      description: 'The Client ID of a Cloudflare Access service token, sent with its Client Secret.',
    },
    accessClientSecret: {
      type: 'apiKey',
      in: 'header',
      name: 'CF-Access-Client-Secret',
      description: 'The Client Secret of the Cloudflare Access service token whose Client ID is sent.',
    },
  });
  for (const operation of Object.values(document.paths['/v1/notes'] ?? {})) {
    expect(operation.security).toStrictEqual([{ accessClientId: [], accessClientSecret: [] }]);
  }
});

it('refuses an MCP transport when it is built', () => {
  expect(() => createHttpHandler(application(), { transports: [mcp()] })).toThrow(
    new TypeError(
      'The MCP transport needs OAuth discovery and bearer tokens; it cannot serve Cloudflare Access application tokens.'
    )
  );
});
