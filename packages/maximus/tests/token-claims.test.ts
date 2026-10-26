/**
 * Access tokens from any OAuth provider: the standard claims by default, `tokens.claims` for providers that
 * name them differently, a person holding only the scopes their permissions also list, machines by Auth0's
 * convention or, opted into, RFC 9068's, forged and malformed claims refused, and the algorithms an issuer
 * may sign with.
 */
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vite-plus/test';

import { createHttpHandler, defineErrors, maximus, ok, t } from '../src/index.ts';
import { createTokenAuthorization, projectToken } from '../src/tokens.ts';
import type { TokenClaims, TokenPolicy } from '../src/tokens.ts';

/** An organization id as an identity provider issues it. */
const ORG = 'org_1234567890abcdef';

/** The principal a token's claims grant, or null when they are refused. */
function principal(claims: Record<string, unknown>, mapping?: TokenClaims) {
  const projected = projectToken(claims, mapping);
  return projected.ok ? projected.value : null;
}

describe('the standard claims', () => {
  it('reads a person from sub, client_id, org_id, scope and permissions', () => {
    expect(
      principal({
        sub: 'user-1',
        client_id: 'web',
        org_id: ORG,
        scope: 'notes:read notes:read',
        permissions: ['notes:read'],
      })
    ).toEqual({
      actorId: 'user-1',
      actorKind: 'user',
      organizationId: ORG,
      scopes: ['notes:read'],
      client: { id: 'web', class: 'human' },
    });
  });

  it('recognizes a machine by its <client>@clients subject, as Auth0 issues it', () => {
    expect(principal({ sub: 'billing@clients', azp: 'billing', org_id: ORG, scope: 'notes:read' })).toEqual({
      actorId: 'billing@clients',
      actorKind: 'service',
      organizationId: ORG,
      scopes: ['notes:read'],
      client: { id: 'billing', class: 'machine' },
    });
  });

  it('takes a subject equal to its client id for a machine only with machineSubject {client}', () => {
    const claims = { sub: 'billing', client_id: 'billing', org_id: ORG, scope: 'notes:read' };
    // RFC 9068, section 5: unless the authorization server rules it out, a person's subject may equal a
    // client id, and must not make them that machine.
    expect(principal(claims)).toMatchObject({ actorKind: 'user', scopes: [] });
    expect(principal(claims, { machineSubject: '{client}' })).toMatchObject({
      actorKind: 'service',
      scopes: ['notes:read'],
      client: { id: 'billing', class: 'machine' },
    });
    // The conventions do not mix: under {client}, Auth0's machine subject is a person's.
    expect(principal({ ...claims, sub: 'billing@clients' }, { machineSubject: '{client}' })).toMatchObject({
      actorKind: 'user',
      scopes: [],
    });
  });

  it('refuses a subject shaped like a machine of another client, and clients that disagree', () => {
    expect(principal({ sub: 'billing@clients', azp: 'web', org_id: ORG, scope: '' })).toBeNull();
    expect(principal({ sub: 'user-1', azp: 'web', client_id: 'other', org_id: ORG, scope: '' })).toBeNull();
  });

  it('admits a token that names no client as a person without one, and one without scopes with none', () => {
    expect(principal({ sub: 'user-1', org_id: ORG, permissions: ['notes:read'] })).toEqual({
      actorId: 'user-1',
      actorKind: 'user',
      organizationId: ORG,
      scopes: [],
    });
  });

  it('refuses malformed claims rather than guessing', () => {
    for (const claims of [
      { org_id: ORG, scope: 'a' },
      { sub: 42, org_id: ORG, scope: 'a' },
      { sub: 'user-1', scope: 'a' },
      { sub: 'user-1', org_id: 'org/other', scope: 'a' },
      { sub: 'user-1', org_id: ORG, scope: 42 },
      { sub: 'user-1', org_id: ORG, scope: ['a', 1] },
      { sub: 'user-1', org_id: ORG, client_id: '', scope: 'a' },
      { sub: 'user-1', org_id: ORG, scope: 'a', permissions: 7 },
      { sub: 'user-1', org_id: ORG, scope: 'a', permissions: [1] },
      { sub: 'user-1', org_id: ORG, scope: 'x'.repeat(256), permissions: ['x'.repeat(256)] },
    ]) {
      expect(principal(claims), JSON.stringify(claims)).toBeNull();
    }
  });
});

describe("a person's permissions", () => {
  const person = { sub: 'user-1', azp: 'web', org_id: ORG, scope: 'notes:read notes:write' };

  it('leave a person only the granted scopes they also list', () => {
    expect(principal({ ...person, permissions: ['notes:read'] })?.scopes).toEqual(['notes:read']);
    expect(principal({ ...person, permissions: 'notes:write notes:admin' })?.scopes).toEqual(['notes:write']);
  });

  it('grant a person nothing when the token lists none, whatever scopes the client requested', () => {
    // Auth0 without RBAC grants any scope a client requests, so the scope claim alone never authorizes.
    expect(principal({ ...person, scope: 'openid notes:notes:admin' })?.scopes).toEqual([]);
  });

  it('are read from the claim the mapping names, or not at all with false', () => {
    expect(principal({ ...person, roles: ['notes:write'] }, { permissions: 'roles' })?.scopes).toEqual([
      'notes:write',
    ]);
    expect(
      principal({ ...person, realm: { roles: ['notes:read'] } }, { permissions: 'realm.roles' })?.scopes
    ).toEqual(['notes:read']);
    expect(principal({ ...person, permissions: 7 }, { permissions: false })?.scopes).toEqual([
      'notes:read',
      'notes:write',
    ]);
  });

  it("never limit a machine's scopes", () => {
    const machine = {
      sub: 'billing@clients',
      azp: 'billing',
      org_id: ORG,
      scope: 'notes:read',
      permissions: [],
    };
    expect(principal(machine)?.scopes).toEqual(['notes:read']);
  });
});

describe('claims named differently', () => {
  it('reads Okta tokens: scopes in scp granted by policy, the client in cid, machines by their client id', () => {
    const okta: TokenClaims = {
      scopes: 'scp',
      client: 'cid',
      permissions: false,
      machineSubject: '{client}',
    };
    expect(
      principal({ sub: 'alice@example.com', cid: 'web-app', org_id: ORG, scp: ['notes:read'] }, okta)
    ).toMatchObject({ actorKind: 'user', scopes: ['notes:read'], client: { id: 'web-app', class: 'human' } });
    expect(
      principal({ sub: 'web-app', cid: 'web-app', org_id: ORG, scp: ['notes:read'] }, okta)
    ).toMatchObject({
      actorKind: 'service',
    });
  });

  it('reads a nested organization, and a claim whose name has dots as it is named', () => {
    expect(
      principal({ sub: 'user_1', o: { id: 'org_2bC4dE6fG8hJ0kL2mN4pQ6rS8tU' } }, { organization: 'o.id' })
    ).toMatchObject({ organizationId: 'org_2bC4dE6fG8hJ0kL2mN4pQ6rS8tU' });
    expect(
      principal(
        { sub: 'user-1', 'https://example.com/org': 'acme' },
        { organization: 'https://example.com/org' }
      )
    ).toMatchObject({ organizationId: 'acme' });
  });

  it('reads scopes from a list claim, such as the permissions of a WorkOS session token', () => {
    expect(
      principal(
        { sub: 'user_1', org_id: ORG, permissions: ['notes:read', 'notes:write'] },
        { scopes: 'permissions' }
      )?.scopes
    ).toEqual(['notes:read', 'notes:write']);
  });

  it('reads only own claims: no path reaches a prototype', () => {
    // `constructor.name` of a plain object is "Object", a valid organization id if it were read.
    expect(principal({ sub: 'user-1' }, { organization: 'constructor.name' })).toBeNull();
    expect(principal({ sub: 'user-1', org_id: ORG }, { scopes: '__proto__.scope' })?.scopes).toEqual([]);
  });
});

/** The application's configuration with one token policy. */
function application(tokens: TokenPolicy) {
  return maximus<Record<string, never>>({
    name: 'notes',
    namespace: 'notes',
    title: 'Notes',
    version: '1',
    origin: 'https://notes.example.test',
    tokens,
    errors: defineErrors({}),
    rpc: { callers: [] },
  });
}

it('refuses at build time algorithms a JWKS cannot verify, and claims it cannot read', () => {
  const issuer = 'https://issuer.example.test/';
  for (const tokens of [
    { issuer, audience: 'notes', algorithms: [] },
    { issuer, audience: 'notes', algorithms: ['HS256'] },
    { issuer, audience: 'notes', claims: { organization: '' } },
    { issuer, audience: 'notes', claims: { permissions: '' } },
    { issuer, audience: 'notes', claims: { permissions: true } },
    { issuer, audience: 'notes', claims: { machineSubject: 'client:{client}' } },
  ]) {
    expect(() => application(tokens as TokenPolicy).build(), JSON.stringify(tokens)).toThrow(TypeError);
  }
  expect(() =>
    application({
      issuer,
      audience: 'notes',
      algorithms: ['ES256', 'EdDSA'],
      claims: { permissions: false, machineSubject: '{client}' },
    }).build()
  ).not.toThrow();
});

it('verifies tokens signed with the algorithms the policy names, and only those', async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ keys: [{ ...jwk, kid: 'ec', alg: 'ES256', use: 'sig' }] }));
  try {
    const token = await new SignJWT({
      sub: 'billing@clients',
      client_id: 'billing',
      org_id: ORG,
      scope: 'notes:read',
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'ec' })
      .setIssuer('https://issuer.example.test/')
      .setAudience('notes')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
    const request = new Request('https://notes.example.test', {
      headers: { authorization: `Bearer ${token}` },
    });
    const policy = { issuer: 'https://issuer.example.test/', audience: 'notes' };
    expect(
      (await createTokenAuthorization({ ...policy, algorithms: ['ES256'] })(request, 'notes:read')).ok
    ).toBe(true);
    // RS256 alone, the default, refuses an ES256 signature.
    expect((await createTokenAuthorization(policy)(request, 'notes:read')).ok).toBe(false);
  } finally {
    fetch.mockRestore();
  }
});

it("admits a resolver's machine named by its client id, as RFC 9068 tokens name it", async () => {
  const request = new Request('https://notes.example.test', { headers: { authorization: 'Bearer opaque' } });
  /** A policy whose resolver returns one machine principal. */
  const resolving = (actorId: string): TokenPolicy => ({
    audience: 'notes',
    issuer: 'https://issuer.example.test/',
    resolve: async () => ({
      actorId,
      actorKind: 'service',
      organizationId: ORG,
      scopes: ['notes:read'],
      client: { id: 'billing', class: 'machine' },
    }),
  });
  for (const actorId of ['billing', 'billing@clients']) {
    expect((await createTokenAuthorization(resolving(actorId))(request, 'notes:read')).ok, actorId).toBe(
      true
    );
  }
  expect((await createTokenAuthorization(resolving('someone-else'))(request, 'notes:read')).ok).toBe(false);
});

describe('the HTTP handler', () => {
  const empty = t.Object({}, { additionalProperties: false });
  /** A notes service with an admin operation and a machine-only one; `ran` counts the handlers run. */
  function service(claims: Record<string, unknown>, mapping?: TokenClaims) {
    const ran = vi.fn(async () => ok({}));
    const app = application({ issuer: 'https://issuer.example.test/', audience: 'notes', claims: mapping })
      .operation(
        'purgeNotes',
        {
          scope: 'notes:notes:admin',
          title: 'Purge notes',
          description: "Delete every note in the caller's organization.",
          effect: 'delete',
          input: empty,
          output: empty,
          http: { method: 'POST', path: '/v1/notes/purge' },
        },
        ran
      )
      .operation(
        'syncNotes',
        {
          scope: 'notes:notes:sync',
          title: 'Sync notes',
          description: 'Copy every note to the archive.',
          effect: 'write',
          input: empty,
          output: empty,
          http: { method: 'POST', path: '/v1/notes/sync' },
          actorKinds: ['service'],
        },
        ran
      )
      .build();
    const handle = createHttpHandler(app, { verify: async () => claims });
    /** Calls one operation by its path. */
    const call = (path: string) =>
      handle(
        new Request(`https://notes.example.test${path}`, {
          method: 'POST',
          headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json' },
          body: '{}',
        }),
        {}
      );
    return { call, ran };
  }

  it('refuses a person the scopes their client requested but their permissions do not list', async () => {
    const { call, ran } = service({
      sub: 'user-1',
      azp: 'web',
      org_id: ORG,
      scope: 'openid notes:notes:admin',
    });
    expect((await call('/v1/notes/purge')).status).toBe(403);
    expect(ran).not.toHaveBeenCalled();
  });

  it('keeps a person whose subject equals a client id out of machine-only operations', async () => {
    const collision = { sub: 'notes-web', azp: 'notes-web', org_id: ORG, scope: 'notes:notes:sync' };
    const { call, ran } = service({ ...collision, permissions: ['notes:notes:sync'] });
    expect((await call('/v1/notes/sync')).status).toBe(403);
    expect(ran).not.toHaveBeenCalled();
    // The authorization server that names machines by their client id says so.
    const machines = service(collision, { machineSubject: '{client}' });
    expect((await machines.call('/v1/notes/sync')).status).toBe(200);
    expect(machines.ran).toHaveBeenCalledOnce();
  });
});
