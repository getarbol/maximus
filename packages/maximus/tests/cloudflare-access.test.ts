/**
 * Cloudflare Access application tokens: what a verified token grants (a person by `sub`, never their email,
 * a service token by its client id, nobody else), its verification against the team's keys for the
 * application's AUD tag, a token read from `Cf-Access-Jwt-Assertion` alone, and the policies `.build()`
 * refuses under the `cloudflare-access` source.
 */
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';

import { defineErrors, maximus, ok, projectAccessToken, t } from '../src/index.ts';
import type { TokenPolicy, TokenPrincipal } from '../src/index.ts';
import { createTokenAuthorization } from '../src/tokens.ts';

/** The team's domain, Access's issuer: without the trailing slash Auth0's has. */
const TEAM = 'https://acme.cloudflareaccess.com';
/** Where the team publishes its keys. */
const CERTS = `${TEAM}/cdn-cgi/access/certs`;
/** The Access application's AUD tag. */
const AUD = '4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2';
/** Another Access application of the same team. */
const OTHER_AUD = '9b2c6f2e5fb6d3c4a1e0f9d8c7b6a5948372615049382716a5b4c3d2e1f0a9b8';
/** The organization of the application's one tenant. */
const ORG = 'org_1234567890abcdef';
/** A service token's client id, as Access names it in `common_name`. */
const SERVICE = '88bf3b6d86161464f6509f7219099e57.access';
/** The scope that reads notes. */
const READ = 'notes:notes:read';
/** The scope that writes notes. */
const WRITE = 'notes:notes:write';
/** A person as Access names them: a user id in `sub`, with the email and claims Access adds. */
const PERSON = {
  type: 'app',
  sub: '7335d417-61da-459d-899c-0a01c76a2f94',
  email: 'ana@example.com',
  identity_nonce: '6ei69kawdKzMIAPF',
  country: 'US',
};
/** A service token as Access names it: an empty `sub` and its client id. */
const SERVICE_TOKEN = { type: 'app', sub: '', common_name: SERVICE };
/** An application of one tenant behind Access, whose people read and whose one service token writes. */
const POLICY: TokenPolicy = {
  source: 'cloudflare-access',
  issuer: TEAM,
  jwksUri: CERTS,
  audience: [AUD],
  algorithms: ['RS256'],
  access: { organizationId: ORG, people: [READ], services: { [SERVICE]: [READ, WRITE] } },
};

/** The principal claims grant under a policy, or null when they are refused. */
function principal(claims: Record<string, unknown>, policy: TokenPolicy = POLICY): TokenPrincipal | null {
  const projected = projectAccessToken({ aud: [AUD], ...claims }, policy);
  return projected.ok ? projected.value : null;
}

describe('what a verified Access application token grants', () => {
  it('names a person by their sub, never their email, through the application as a human client', () => {
    expect(principal(PERSON)).toStrictEqual({
      actorId: PERSON.sub,
      actorKind: 'user',
      organizationId: ORG,
      scopes: [READ],
      client: { id: AUD, class: 'human' },
    });
    // Without a subject, the email is never the actor.
    const { sub: _subject, ...anonymous } = PERSON;
    expect(principal(anonymous)).toBeNull();
  });

  it('names a service token by its client id, holding the scopes listed under it', () => {
    expect(principal(SERVICE_TOKEN)).toStrictEqual({
      actorId: SERVICE,
      actorKind: 'service',
      organizationId: ORG,
      scopes: [READ, WRITE],
      client: { id: SERVICE, class: 'machine' },
    });
  });

  it('grants service tokens nothing under a policy that lists none, and reads an audience given alone', () => {
    const people = { ...POLICY, audience: AUD, access: { organizationId: ORG, people: [READ] } };
    expect(principal(SERVICE_TOKEN, people)).toMatchObject({ actorKind: 'service', scopes: [] });
    expect(principal(PERSON, people)).toMatchObject({ scopes: [READ], client: { id: AUD, class: 'human' } });
  });

  it('grants a service token the policy does not list nothing, even one named like a prototype property', () => {
    for (const commonName of ['0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f.access', 'constructor', '__proto__']) {
      expect(principal({ ...SERVICE_TOKEN, common_name: commonName }), commonName).toMatchObject({
        actorId: commonName,
        actorKind: 'service',
        scopes: [],
      });
    }
  });

  it('refuses a token that is neither a person’s nor a service token’s', () => {
    for (const claims of [
      { ...PERSON, common_name: SERVICE },
      { ...SERVICE_TOKEN, sub: 'f3b1c2d4' },
      { type: 'app', sub: '' },
      { ...SERVICE_TOKEN, common_name: '' },
      { ...PERSON, sub: 42 },
      { ...SERVICE_TOKEN, common_name: ['a.access'] },
      { ...PERSON, sub: 'x'.repeat(256) },
    ]) {
      expect(principal(claims), JSON.stringify(claims)).toBeNull();
    }
  });

  it('refuses a token that is not an application token: an organization token or one without a type', () => {
    expect(principal({ ...PERSON, type: 'org' })).toBeNull();
    const { type: _type, ...untyped } = PERSON;
    expect(principal(untyped)).toBeNull();
  });

  it('refuses a token for another application, and any token under a policy without access', () => {
    expect(principal({ ...PERSON, aud: [OTHER_AUD] })).toBeNull();
    expect(principal({ ...PERSON, aud: OTHER_AUD })).toBeNull();
    expect(principal({ ...PERSON, aud: 7 })).toBeNull();
    // A string audience names the application as well as a list of one.
    expect(principal({ ...PERSON, aud: AUD })).toMatchObject({ client: { id: AUD } });
    const { access: _access, ...unconfigured } = POLICY;
    expect(principal(PERSON, unconfigured)).toBeNull();
  });

  it('reads the organization from the claim the policy names, and refuses a token without a valid one', () => {
    const tenants: TokenPolicy = {
      ...POLICY,
      access: { people: [READ] },
      claims: { organization: 'custom.org_id' },
    };
    expect(principal({ ...PERSON, custom: { org_id: 'org_acme' } }, tenants)).toMatchObject({
      organizationId: 'org_acme',
    });
    for (const custom of [undefined, {}, { org_id: '../org_other' }, { org_id: 7 }]) {
      expect(principal({ ...PERSON, custom }, tenants), JSON.stringify(custom)).toBeNull();
    }
    // A policy that names it twice, or not at all, grants nobody.
    expect(principal(PERSON, { ...tenants, access: { organizationId: ORG, people: [READ] } })).toBeNull();
    expect(principal(PERSON, { ...tenants, claims: {} })).toBeNull();
  });
});

describe('admission of Access application tokens', () => {
  /** A key pair: the team's, or a forger's. */
  type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
  /** The team's key pair, whose public key the mocked certificates serve. */
  let team: KeyPair;
  /** A key pair the team never published. */
  let forger: KeyPair;
  beforeAll(async () => {
    team = await generateKeyPair('RS256', { extractable: true });
    forger = await generateKeyPair('RS256');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Serves the team's keys as Access does, a JWKS beside the certificates of the same keys, to every fetch;
   * answers the spy.
   */
  async function serveKeys() {
    const jwk = await exportJWK(team.publicKey);
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({
        keys: [{ ...jwk, kid: 'access-1', alg: 'RS256', use: 'sig' }],
        public_cert: { kid: 'access-1', cert: '-----BEGIN CERTIFICATE-----' },
        public_certs: [{ kid: 'access-1', cert: '-----BEGIN CERTIFICATE-----' }],
      })
    );
  }
  /** An application token Access would sign, for the issuer, audience and expiry given. */
  async function token(
    claims: Record<string, unknown>,
    signed: { key?: KeyPair['privateKey']; issuer?: string; audience?: string[]; expiry?: string } = {}
  ) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'access-1', typ: 'JWT' })
      .setIssuer(signed.issuer ?? TEAM)
      .setAudience(signed.audience ?? [AUD])
      .setIssuedAt()
      .setNotBefore('0s')
      .setExpirationTime(signed.expiry ?? '1h')
      .sign(signed.key ?? team.privateKey);
  }
  /** A request to the application with these headers. */
  const request = (headers: Record<string, string>) =>
    new Request('https://notes.example.test/v1/notes', { headers });

  it('admits a person and a service token from Cf-Access-Jwt-Assertion, verified against the team’s keys', async () => {
    const fetch = await serveKeys();
    const authorize = createTokenAuthorization(POLICY);
    expect(await authorize(request({ 'cf-access-jwt-assertion': await token(PERSON) }), READ)).toMatchObject({
      ok: true,
      value: { actorId: PERSON.sub, actorKind: 'user' },
    });
    expect(
      await authorize(request({ 'cf-access-jwt-assertion': await token(SERVICE_TOKEN) }), WRITE)
    ).toMatchObject({ ok: true, value: { actorId: SERVICE, actorKind: 'service' } });
    // A person holds the people's scopes alone.
    expect(await authorize(request({ 'cf-access-jwt-assertion': await token(PERSON) }), WRITE)).toMatchObject(
      { ok: false, error: { code: 'FORBIDDEN' } }
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toBe(CERTS);
  });

  it('refuses a token for another application, from another issuer, expired, forged or of the organization', async () => {
    await serveKeys();
    const authorize = createTokenAuthorization(POLICY);
    for (const [label, refused] of [
      ['another application, the same key', await token(PERSON, { audience: [OTHER_AUD] })],
      ['another issuer', await token(PERSON, { issuer: 'https://other.cloudflareaccess.com' })],
      ['an issuer with a trailing slash', await token(PERSON, { issuer: `${TEAM}/` })],
      ['expired', await token(PERSON, { expiry: '-1h' })],
      ['forged', await token(PERSON, { key: forger.privateKey })],
      ['an organization token', await token({ ...PERSON, type: 'org' })],
      ['a subject with a common name', await token({ ...PERSON, common_name: SERVICE })],
    ] as const) {
      expect(await authorize(request({ 'cf-access-jwt-assertion': refused }), READ), label).toMatchObject({
        ok: false,
        error: { code: 'UNAUTHORIZED' },
      });
    }
  });

  it('reads the token from Cf-Access-Jwt-Assertion alone: never Authorization, the cookie or an unsigned header', async () => {
    const fetch = await serveKeys();
    const authorize = createTokenAuthorization(POLICY);
    const valid = await token(PERSON);
    for (const [label, headers] of [
      ['Authorization alone', { authorization: `Bearer ${valid}` }],
      ['the CF_Authorization cookie alone', { cookie: `CF_Authorization=${valid}` }],
      ['the email Access forwards, unsigned', { 'cf-access-authenticated-user-email': PERSON.email }],
      ['no token at all', {}],
      ['not a compact JWS', { 'cf-access-jwt-assertion': `${valid} ${valid}` }],
      ['beside an x-api-key', { 'cf-access-jwt-assertion': valid, 'x-api-key': 'key-0123456789' }],
    ] as const) {
      expect(await authorize(request(headers), READ), label).toMatchObject({
        ok: false,
        error: { code: 'UNAUTHORIZED' },
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('hands the Access token, never the Authorization header’s, to the application’s own resolver', async () => {
    const resolve = vi.fn(async () => ({
      actorId: PERSON.sub,
      actorKind: 'user' as const,
      organizationId: ORG,
      scopes: [READ],
    }));
    const { access: _access, ...rest } = POLICY;
    const authorize = createTokenAuthorization({ ...rest, resolve });
    const admitted = await authorize(
      request({ 'cf-access-jwt-assertion': 'access.application.token', authorization: 'Bearer other' }),
      READ
    );
    expect(admitted.ok).toBe(true);
    expect(resolve).toHaveBeenCalledWith('access.application.token', undefined);
    expect((await authorize(request({ authorization: 'Bearer other' }), READ)).ok).toBe(false);
    expect(resolve).toHaveBeenCalledOnce();
  });
});

describe('the policies .build() refuses under Cloudflare Access', () => {
  /** The input and output of the one operation: nothing. */
  const empty = t.Object({}, { additionalProperties: false });
  /** A notes service under a token policy, built. */
  const build = (tokens: TokenPolicy) => () =>
    maximus<Record<string, never>>({
      name: 'notes',
      namespace: 'notes',
      title: 'Notes',
      version: '1',
      origin: 'https://notes.example.test',
      tokens,
      errors: defineErrors({}),
      rpc: { callers: [] },
    })
      .operation(
        'listNotes',
        {
          scope: READ,
          title: 'List notes',
          description: 'List the organization notes.',
          effect: 'read',
          input: empty,
          output: empty,
          http: { method: 'GET', path: '/v1/notes' },
        },
        async () => ok({})
      )
      .build();
  // What the policy grants, and the policy without it.
  const { access, ...unprojected } = POLICY;
  /** Grants that name what people hold and no organization. */
  const people = { people: [READ] };

  it('builds an application of one tenant, of tenants by claim, and one whose resolver verifies the tokens', () => {
    expect(build(POLICY)).not.toThrow();
    expect(build({ ...POLICY, access: people, claims: { organization: 'custom.org_id' } })).not.toThrow();
    const { issuer: _issuer, jwksUri: _jwks, ...issuerless } = unprojected;
    expect(build({ ...issuerless, resolve: async () => principalOf() })).not.toThrow();
  });

  it('refuses a policy that could admit nobody, or names the organization twice or not at all', () => {
    expect(build(unprojected)).toThrow(
      'tokens.source cloudflare-access requires tokens.access, or tokens.resolve to verify Access tokens itself.'
    );
    const once =
      'Under Cloudflare Access, name a valid organization once: tokens.access.organizationId or tokens.claims.organization.';
    for (const tokens of [
      { ...POLICY, access: people },
      { ...POLICY, claims: { organization: 'custom.org_id' } },
      { ...POLICY, access: { ...people, organizationId: '../org' } },
      { ...POLICY, access: people, claims: { organization: '' } },
    ]) {
      expect(build(tokens), JSON.stringify(tokens)).toThrow(once);
    }
    const { issuer: _issuer, ...issuerless } = POLICY;
    expect(build(issuerless)).toThrow('tokens.issuer is required to verify or document OAuth access tokens.');
  });

  it('refuses what only OAuth access tokens use, and claims besides the organization', () => {
    for (const [option, value] of [
      ['scheme', { type: 'oauth' }],
      ['resources', {}],
      ['resourceMetadataUrl', null],
      ['authorizationEndpoint', 'authorize'],
      ['tokenEndpoint', 'oauth/token'],
    ] as const) {
      expect(build({ ...POLICY, [option]: value }), option).toThrow(
        `Cloudflare Access application tokens are not OAuth access tokens: remove tokens.${option}.`
      );
    }
    expect(build({ ...POLICY, claims: { scopes: 'custom.groups' } })).toThrow(
      'Under Cloudflare Access, tokens.claims names the organization alone: tokens.access grants the scopes.'
    );
  });

  it("refuses scopes outside the application's namespace, to people or to a service token", () => {
    const scopes =
      'tokens.access grants scopes of notes:<resource>:<action>, at most 1000 to people and to each service token, by its client id.';
    for (const granted of [
      { ...access, people: ['billing:invoices:read'] },
      { ...access, people: ['notes'] },
      { ...access, people: Array.from({ length: 1001 }, () => READ) },
      { ...access, services: { [SERVICE]: ['billing:invoices:write'] } },
      { ...access, services: { '': [READ] } },
    ]) {
      expect(build({ ...POLICY, access: granted as TokenPolicy['access'] }), JSON.stringify(granted)).toThrow(
        scopes
      );
    }
  });

  it('refuses access without the Access source, and a source it does not know', () => {
    expect(build({ ...unprojected, source: 'authorization', access })).toThrow(
      'tokens.access grants Cloudflare Access callers: set tokens.source to cloudflare-access.'
    );
    expect(build({ ...POLICY, source: 'cf-access' as TokenPolicy['source'] })).toThrow(
      'tokens.source is authorization or cloudflare-access.'
    );
  });
});

/** A person in the organization, as a resolver answers one. */
function principalOf(): TokenPrincipal {
  return { actorId: PERSON.sub, actorKind: 'user', organizationId: ORG, scopes: [READ] };
}
