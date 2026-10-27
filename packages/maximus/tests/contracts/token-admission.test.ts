/**
 * Token admission at its edges: a custom resolver's refusals answered as the standard ones and never with
 * their text, malformed or self-contradicting principals, a resolver that throws, scopes a resolved
 * principal lacks, the development token without an env to read or beyond the declared scopes, and a
 * verifier that refuses an issuer or JWKS outside HTTPS.
 */
import { expect, it, vi } from 'vite-plus/test';

import { createTokenAuthorization, createTokenVerifier, err, ok, standardErrors } from '../../src/index.ts';
import type { TokenPolicy, TokenPrincipal, TokenResolutionContext } from '../../src/index.ts';

const READ = 'records:records:read';
const WRITE = 'records:records:write';
const unauthorized = err(standardErrors.unauthorized.create());
const forbidden = err(standardErrors.forbidden.create());
const principal: TokenPrincipal = {
  actorId: 'person',
  actorKind: 'user',
  organizationId: 'org_1234567890abcdef',
  scopes: [READ],
  client: { id: 'portal', class: 'human' },
};
const request = (token = 'opaque-session-token', url = 'https://records.example.test/v1/records') =>
  new Request(url, { headers: { authorization: `Bearer ${token}` } });
/** An application that issues its own bearer tokens and resolves them with `resolve`. */
const own = (resolve: NonNullable<TokenPolicy['resolve']>): TokenPolicy => ({
  audience: 'https://records.example.test',
  scheme: { type: 'bearer', description: 'A session token.' },
  resolve,
});

it("answers a resolver's refusal as FORBIDDEN or UNAUTHORIZED, never with the resolver's own failure", async () => {
  const refusing = createTokenAuthorization(own(async () => err(standardErrors.forbidden.create())));
  expect(await refusing(request(), READ)).toEqual(forbidden);
  const revoked = {
    code: 'SESSION_REVOKED',
    message: 'Session revoked by 10.0.0.7',
    retryable: false,
    data: { sessionId: 'SESSION_SENTINEL' },
  };
  const answered = await createTokenAuthorization(own(async () => err(revoked)))(request(), READ);
  expect(answered).toEqual(unauthorized);
  expect(JSON.stringify(answered)).not.toMatch(/10\.0\.0\.7|SENTINEL/);
});

it('refuses a resolved principal that is malformed or whose client contradicts its actor', async () => {
  const resolved: unknown[] = [
    { ...principal, organizationId: '../another-org' },
    { ...principal, actorKind: 'admin' },
    { ...principal, scopes: READ },
    { ...principal, isAdmin: true },
    ok({ ...principal, actorId: '' }),
    // A person with a machine's client, and a machine whose actor names another client.
    { ...principal, client: { id: 'worker', class: 'machine' } },
    {
      ...principal,
      actorKind: 'service',
      actorId: 'another-worker',
      client: { id: 'worker', class: 'machine' },
    },
  ];
  for (const value of resolved) {
    const authorize = createTokenAuthorization(own(async () => value as TokenPrincipal));
    expect(await authorize(request(), READ), JSON.stringify(value)).toEqual(unauthorized);
  }
});

it('refuses the token when the resolver throws, without the error reaching the answer', async () => {
  const failing = createTokenAuthorization(
    own(async () => {
      throw new Error('session store at 10.0.0.7 is down');
    })
  );
  const answered = await failing(request(), READ);
  expect(answered).toEqual(unauthorized);
  expect(JSON.stringify(answered)).not.toContain('10.0.0.7');
});

it('refuses a resolved principal without the required scope, and admits one holding any of the accepted ones', async () => {
  const authorize = createTokenAuthorization(own(async () => principal));
  expect(await authorize(request(), WRITE)).toEqual(forbidden);
  expect(await authorize(request(), [WRITE, READ])).toEqual(ok(principal));
  expect(await authorize(request(), [WRITE, READ], undefined, 'all')).toEqual(forbidden);
  // A resolver may answer a Result or the principal itself.
  expect(await createTokenAuthorization(own(async () => ok(principal)))(request(), READ)).toEqual(
    ok(principal)
  );
});

it('admits the development token only with an env to read it from, and only for the scopes the application declares', async () => {
  const token = 'local-development-token-0123456789';
  const verify = vi.fn(async () => {
    throw new Error('Not an access token.');
  });
  const authorize = createTokenAuthorization(
    {
      issuer: 'https://issuer.example.test/',
      audience: 'https://records.example.test',
      development: { binding: 'DEVELOPMENT_TOKEN' },
    },
    verify
  );
  const local = request(token, 'http://localhost:8787/v1/records');
  const context = (env: unknown): TokenResolutionContext => ({
    env,
    request: local,
    surface: 'http',
    applicationScopes: [READ],
  });
  expect(await authorize(local, READ, context({ DEVELOPMENT_TOKEN: token }))).toMatchObject({
    ok: true,
    value: {
      actorId: 'local-developer',
      scopes: [READ],
      client: { id: 'local-development', class: 'human' },
    },
  });
  expect(verify).not.toHaveBeenCalled();
  // A scope the application never declared is not the developer's either.
  expect(await authorize(local, WRITE, context({ DEVELOPMENT_TOKEN: token }))).toEqual(forbidden);
  // Without an env to read, or without a context, it is verified like any other token, and refused.
  expect(await authorize(local, READ, context(undefined))).toEqual(unauthorized);
  expect(await authorize(local, READ)).toEqual(unauthorized);
  expect(verify).toHaveBeenCalledTimes(2);
});

it('refuses to build a verifier whose issuer or JWKS is not HTTPS', () => {
  const policy = { issuer: 'https://issuer.example.test/', audience: 'https://records.example.test' };
  for (const insecure of [
    { ...policy, jwksUri: 'http://keys.example.test/jwks.json' },
    { ...policy, issuer: 'http://issuer.example.test/' },
  ]) {
    expect(() => createTokenVerifier(insecure), JSON.stringify(insecure)).toThrow(
      new TypeError('Token authority must use HTTPS.')
    );
  }
  expect(() => createTokenVerifier({ ...policy, jwksUri: '/keys.json' })).not.toThrow();
});
