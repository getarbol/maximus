/**
 * OAuth access token verification against a JWKS: signature, issuer, audiences and expiry.
 */
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { it, expect, vi } from 'vite-plus/test';

import { createHttpHandler, defineErrors, maximus, ok, t } from '../src/index.ts';
import { createTokenAuthorization } from '../src/tokens.ts';

it('verifies signatures, issuer, audience and expiry through remote public keys', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ keys: [{ ...jwk, kid: 'test', alg: 'RS256', use: 'sig' }] }));
  async function token(audience = 'expected', expiry = '1h') {
    return new SignJWT({
      sub: 'client@clients',
      client_id: 'client',
      org_id: 'org_1234567890abcdef',
      scope: 'read',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer('https://issuer.test/')
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(expiry)
      .sign(privateKey);
  }
  try {
    const authorize = createTokenAuthorization({ issuer: 'https://issuer.test/', audience: 'expected' });
    const request = (value: string) =>
      new Request('https://app.test', { headers: { authorization: `Bearer ${value}` } });
    expect((await authorize(request(await token()), 'read')).ok).toBe(true);
    expect((await authorize(request(await token('wrong')), 'read')).ok).toBe(false);
    expect((await authorize(request(await token('expected', '-1h')), 'read')).ok).toBe(false);
    expect((await authorize(request(`${(await token()).slice(0, -20)}invalidsignature`), 'read')).ok).toBe(
      false
    );
    expect(fetch).toHaveBeenCalledOnce();
  } finally {
    fetch.mockRestore();
  }
});

const ISSUER = 'https://issuer.example.test/';
const SERVICE = 'https://notes.example.test';
const PLATFORM = 'https://platform.example.test';
const empty = t.Object({}, { additionalProperties: false });
function application(audience: string | readonly string[]) {
  return maximus<Record<string, never>>({
    name: 'notes',
    namespace: 'notes',
    title: 'Notes',
    version: '1',
    origin: SERVICE,
    tokens: { issuer: ISSUER, audience },
    errors: defineErrors({}),
    rpc: { callers: [] },
    telemetry: { enabled: false },
  })
    .operation(
      'listNotes',
      {
        title: 'List notes',
        description: 'List the organization notes.',
        effect: 'read' as const,
        scope: 'notes:notes:read',
        input: empty,
        output: empty,
        http: { method: 'POST' as const, path: '/v1/notes/list' },
      },
      async () => ok({})
    )
    .build();
}

it('accepts a token for any listed audience, refuses an unlisted one and names the first as the resource', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ keys: [{ ...jwk, kid: 'test', alg: 'RS256', use: 'sig' }] }));
  const token = (audience: string) =>
    new SignJWT({
      sub: 'client@clients',
      client_id: 'client',
      org_id: 'org_1234567890abcdef',
      scope: 'notes:notes:read',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer(ISSUER)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
  try {
    const handle = createHttpHandler(application([SERVICE, PLATFORM]));
    const list = async (audience: string) =>
      (
        await handle(
          new Request(`${SERVICE}/v1/notes/list`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${await token(audience)}`,
              'content-type': 'application/json',
            },
            body: '{}',
          }),
          {}
        )
      ).status;
    expect(await list(SERVICE)).toBe(200);
    expect(await list(PLATFORM)).toBe(200);
    expect(await list('https://other.example.test')).toBe(401);
    const metadata = await handle(new Request(`${SERVICE}/.well-known/oauth-protected-resource`), {});
    expect(await metadata.json()).toMatchObject({ resource: SERVICE, authorization_servers: [ISSUER] });
    expect(fetch).toHaveBeenCalledOnce();
  } finally {
    fetch.mockRestore();
  }
});

it('refuses at construction an empty audience, an empty list and a repeated audience', () => {
  for (const audience of ['', [], [SERVICE, ''], [SERVICE, PLATFORM, SERVICE]]) {
    expect(() => application(audience)).toThrow(
      new TypeError(
        'tokens.audience must be a non-empty string or a non-empty list of distinct non-empty strings.'
      )
    );
  }
  expect(() => application([PLATFORM])).not.toThrow();
  expect(() => application(SERVICE)).not.toThrow();
});
