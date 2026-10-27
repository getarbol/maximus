/**
 * Access tokens Auth0 issues, under the options `auth0()` states: both of its token dialects, an audience
 * listed beside the userinfo endpoint's, a person's scopes limited to their permissions, machine tokens, a
 * client credentials token that never passes as a person, a tenant answering to its own and a custom domain,
 * and the `typ` header of RFC 9068 access tokens.
 */
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { JWTHeaderParameters } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { MockInstance } from 'vite-plus/test';

import { createHttpHandler, defineErrors, maximus, ok, projectToken, t } from '../src/index.ts';
import type { TokenPolicy } from '../src/index.ts';
import { auth0 } from '../src/vite/tokens.ts';
import type { Auth0Options } from '../src/vite/tokens.ts';

/** The tenant's own domain. */
const TENANT = 'acme.us.auth0.com';
/** The custom domain the tenant also answers to. */
const CUSTOM = 'login.acme.example';
/** The API's identifier in Auth0, its access tokens' audience. */
const API = 'https://notes.example.test';
/** The organization the callers belong to, as Auth0 names it in `org_id`. */
const ORG = 'org_1234567890abcdef';
/** The scope that reads notes. */
const READ = 'notes:notes:read';
/** The scope that writes notes. */
const WRITE = 'notes:notes:write';

/** The token policy `auth0()` states for these options, as the application receives it. */
function policy(options: Partial<Auth0Options> = {}): TokenPolicy {
  const { development: _none, ...tokens } = auth0({ domain: TENANT, audience: API, ...options });
  return { ...tokens, audience: options.audience ?? API };
}

/** What the operations answer: who called and through which client. */
const Caller = t.Object(
  {
    actorId: t.String(),
    actorKind: t.String(),
    client: t.Union([t.String(), t.Null()]),
    clientClass: t.Union([t.String(), t.Null()]),
    scopes: t.Array(t.String()),
  },
  { additionalProperties: false }
);
/** The input of every operation: nothing. */
const empty = t.Object({}, { additionalProperties: false });

/** A notes service that reads and writes, each answering who called, served under a token policy. */
function service(tokens: TokenPolicy = policy()) {
  /** Answers the caller and the authority of the call. */
  const whoCalled = async (context: {
    principal: { actorId: string; actorKind: string };
    authority?: { client: { id: string; class: string }; scopes: readonly string[] };
  }) =>
    ok({
      actorId: context.principal.actorId,
      actorKind: context.principal.actorKind,
      client: context.authority?.client.id ?? null,
      clientClass: context.authority?.client.class ?? null,
      scopes: [...(context.authority?.scopes ?? [])],
    });
  const app = maximus<Record<string, never>>({
    name: 'notes',
    namespace: 'notes',
    title: 'Notes',
    version: '1',
    origin: API,
    tokens,
    errors: defineErrors({}),
    rpc: { callers: [] },
    telemetry: { enabled: false },
  })
    .operation(
      'listNotes',
      {
        scope: READ,
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
        scope: WRITE,
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
  const handle = createHttpHandler(app);
  /** Calls the read (GET) or the write (POST) with a bearer token. */
  return (method: 'GET' | 'POST', token: string) =>
    handle(
      new Request(`${API}/v1/notes`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
      }),
      {}
    );
}

/** The tenant's signing key pair. */
let tenant: Awaited<ReturnType<typeof generateKeyPair>>;
/** The fetch that serves the tenant's keys, as its JWKS. */
let fetch: MockInstance<typeof globalThis.fetch>;
beforeAll(async () => {
  tenant = await generateKeyPair('RS256', { extractable: true });
});
beforeEach(async () => {
  const jwk = await exportJWK(tenant.publicKey);
  fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () =>
      Response.json({ keys: [{ ...jwk, kid: 'tenant-1', alg: 'RS256', use: 'sig' }] })
    );
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** An access token the tenant signs, by default with Auth0's `JWT` type, issuer and audiences. */
function accessToken(
  claims: Record<string, unknown>,
  signed: { typ?: unknown; issuer?: string; audience?: string[] } = {}
) {
  // jose types `typ` as a string, where a token may carry any value.
  const header = {
    alg: 'RS256',
    kid: 'tenant-1',
    typ: signed.typ ?? 'JWT',
  } as unknown as JWTHeaderParameters;
  return new SignJWT({ org_id: ORG, ...claims })
    .setProtectedHeader(header)
    .setIssuer(signed.issuer ?? `https://${TENANT}/`)
    .setAudience(signed.audience ?? [API, `https://${TENANT}/userinfo`])
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(tenant.privateKey);
}

/** The data a call answered. */
async function caller(response: Response) {
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: unknown }).data;
}

describe("Auth0's token dialect", () => {
  it('admits a person, whose audiences include the userinfo endpoint, to what both scope and permissions list', async () => {
    const call = service();
    const token = await accessToken({
      sub: 'auth0|65f0c1d2e3',
      azp: 'notes-web',
      scope: `openid profile ${READ} ${WRITE}`,
      permissions: [READ],
    });
    expect(await caller(await call('GET', token))).toStrictEqual({
      actorId: 'auth0|65f0c1d2e3',
      actorKind: 'user',
      client: 'notes-web',
      clientClass: 'human',
      scopes: [READ],
    });
    // The client requested the write, but the person's permissions do not list it.
    expect((await call('POST', token)).status).toBe(403);
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toBe(`https://${TENANT}/.well-known/jwks.json`);
  });

  it('admits a machine token of the client credentials grant with every scope it is granted', async () => {
    const call = service();
    const token = await accessToken({
      sub: 'billing-client@clients',
      azp: 'billing-client',
      gty: 'client-credentials',
      scope: `${READ} ${WRITE}`,
    });
    expect(await caller(await call('POST', token))).toStrictEqual({
      actorId: 'billing-client@clients',
      actorKind: 'service',
      client: 'billing-client',
      clientClass: 'machine',
      scopes: [READ, WRITE],
    });
  });

  it('refuses a client credentials token whose subject is not its client’s machine', async () => {
    const call = service();
    for (const claims of [
      { sub: 'auth0|65f0c1d2e3', azp: 'billing-client', gty: 'client-credentials' },
      { sub: 'billing-client', azp: 'billing-client', gty: ['client-credentials'] },
      { sub: 'auth0|65f0c1d2e3', gty: 'client-credentials' },
      { sub: 'auth0|65f0c1d2e3', azp: 'notes-web', gty: 'refresh_token client-credentials' },
      // A grant claim that cannot be read is refused rather than guessed at.
      { sub: 'auth0|65f0c1d2e3', azp: 'notes-web', gty: { grant: 'client-credentials' } },
    ]) {
      const token = await accessToken({ ...claims, scope: READ, permissions: [READ] });
      expect((await call('GET', token)).status, JSON.stringify(claims)).toBe(401);
    }
    // Other grants are a person's as before.
    const password = await accessToken({
      sub: 'auth0|65f0c1d2e3',
      azp: 'notes-web',
      gty: ['refresh_token', 'password'],
      scope: READ,
      permissions: [READ],
    });
    expect(await caller(await call('GET', password))).toMatchObject({ actorKind: 'user' });
  });
});

describe('the RFC 9068 token dialect', () => {
  it('admits a person and a machine named by client_id, typed at+jwt', async () => {
    const call = service();
    const person = await accessToken(
      { sub: 'auth0|65f0c1d2e3', client_id: 'notes-web', scope: `${READ} ${WRITE}`, permissions: [READ] },
      { typ: 'at+jwt', audience: [API] }
    );
    expect(await caller(await call('GET', person))).toMatchObject({
      actorKind: 'user',
      client: 'notes-web',
      scopes: [READ],
    });
    const machine = await accessToken(
      { sub: 'billing-client@clients', client_id: 'billing-client', scope: WRITE },
      { typ: 'at+jwt', audience: [API] }
    );
    expect(await caller(await call('POST', machine))).toMatchObject({
      actorKind: 'service',
      client: 'billing-client',
      clientClass: 'machine',
    });
  });

  it('admits a plain JWT or an access token by its typ, and refuses a token typed as anything else', async () => {
    const call = service();
    /** The status a machine token of this `typ` header is answered with. */
    const status = async (typ: unknown) => {
      const token = await accessToken({ sub: 'm@clients', client_id: 'm', scope: READ }, { typ });
      return (await call('GET', token)).status;
    };
    for (const typ of ['JWT', 'jwt', 'application/jwt', 'at+jwt', 'AT+JWT', 'application/at+jwt']) {
      expect(await status(typ), String(typ)).toBe(200);
    }
    for (const typ of ['dpop+jwt', 'logout+jwt', 'secevent+jwt', 'application/id_token+jwt', 'JOSE', 7]) {
      expect(await status(typ), String(typ)).toBe(401);
    }
    // A token with no typ header at all is a plain JWT.
    const untyped = await new SignJWT({ org_id: ORG, sub: 'm@clients', client_id: 'm', scope: READ })
      .setProtectedHeader({ alg: 'RS256', kid: 'tenant-1' })
      .setIssuer(`https://${TENANT}/`)
      .setAudience(API)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(tenant.privateKey);
    expect((await call('GET', untyped)).status).toBe(200);
  });
});

describe('a tenant with a custom domain', () => {
  it('admits tokens either domain issued, fetches the keys and names the server by the first', async () => {
    const call = service(policy({ domain: [TENANT, CUSTOM] }));
    const claims = { sub: 'm@clients', azp: 'm', gty: 'client-credentials', scope: READ };
    for (const domain of [TENANT, CUSTOM]) {
      const token = await accessToken(claims, { issuer: `https://${domain}/` });
      expect((await call('GET', token)).status, domain).toBe(200);
    }
    for (const issuer of [`https://${CUSTOM}`, 'https://other.us.auth0.com/']) {
      expect((await call('GET', await accessToken(claims, { issuer }))).status, issuer).toBe(401);
    }
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toBe(`https://${TENANT}/.well-known/jwks.json`);
  });

  it('publishes the first issuer in discovery, and refuses a list it could not verify by', async () => {
    const tokens = policy({ domain: [CUSTOM, TENANT] });
    /** A notes service without operations, under these issuers. */
    const application = (issuer: TokenPolicy['issuer']) =>
      maximus<Record<string, never>>({
        name: 'notes',
        namespace: 'notes',
        title: 'Notes',
        version: '1',
        origin: API,
        tokens: { ...tokens, issuer },
        errors: defineErrors({}),
        rpc: { callers: [] },
      }).build();
    const metadata = await createHttpHandler(application(tokens.issuer))(
      new Request(`${API}/.well-known/oauth-protected-resource`),
      {}
    );
    expect(await metadata.json()).toMatchObject({ authorization_servers: [`https://${CUSTOM}/`] });
    const distinct = 'tokens.issuer is one issuer, or a list of distinct issuers, the canonical one first.';
    for (const [issuer, refusal] of [
      [[], 'tokens.issuer is required to verify or document OAuth access tokens.'],
      [[`https://${TENANT}/`, `https://${TENANT}/`], distinct],
      [[`https://${TENANT}/`, ''], distinct],
      [[`https://${TENANT}/`, `http://${CUSTOM}/`], 'must be absolute HTTPS URLs'],
    ] as const) {
      expect(() => application(issuer), refusal).toThrow(refusal);
    }
  });
});

it('refuses, without a subject shaped like a machine, the projection of a client credentials token', () => {
  const machine = { sub: 'billing@clients', azp: 'billing', org_id: ORG, scope: READ };
  expect(projectToken({ ...machine, gty: 'client-credentials' })).toMatchObject({ ok: true });
  expect(projectToken({ ...machine, sub: 'billing', gty: 'client-credentials' }).ok).toBe(false);
  // Under RFC 9068's subjects, the client id itself is the machine's.
  expect(
    projectToken({ ...machine, sub: 'billing', gty: 'client-credentials' }, { machineSubject: '{client}' })
  ).toMatchObject({ ok: true, value: { actorKind: 'service' } });
});
