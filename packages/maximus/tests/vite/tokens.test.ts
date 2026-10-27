/**
 * The token presets of `@arbol-ai/maximus/vite`: the options `auth0()` and `cloudflareAccess()` state, as plain
 * data that survives the generated modules' JSON, never the development token, and the inputs each refuses.
 */
import { describe, expect, it } from 'vite-plus/test';

import { auth0, cloudflareAccess } from '../../src/vite/index.ts';
import type { Auth0Options, CloudflareAccessOptions } from '../../src/vite/index.ts';

/** An Access application's AUD tag. */
const AUD = '4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2';

/** Whether a value is plain data: JSON gives it back unchanged, with no undefined field. */
function jsonRoundTrip(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

describe('auth0()', () => {
  it("states the tenant's issuer with its trailing slash, the audience and RS256", () => {
    const tokens = auth0({ domain: 'acme.us.auth0.com', audience: 'https://notes.example.com' });
    expect(tokens).toStrictEqual({
      issuer: 'https://acme.us.auth0.com/',
      audience: 'https://notes.example.com',
      algorithms: ['RS256'],
    });
    expect(jsonRoundTrip(tokens)).toStrictEqual(tokens);
  });

  it('lists a custom domain beside the canonical one, several audiences and the algorithms an API signs with', () => {
    const tokens = auth0({
      domain: ['login.acme.example', 'acme.us.auth0.com'],
      audience: ['https://notes.example.com', 'https://api.example.com'],
      algorithms: ['PS256', 'RS512'],
    });
    expect(tokens).toStrictEqual({
      issuer: ['https://login.acme.example/', 'https://acme.us.auth0.com/'],
      audience: ['https://notes.example.com', 'https://api.example.com'],
      algorithms: ['PS256', 'RS512'],
    });
    expect(jsonRoundTrip(tokens)).toStrictEqual(tokens);
  });

  it('refuses a domain with a scheme, a path or a port, and one that is no lowercase host name', () => {
    for (const domain of [
      'https://acme.us.auth0.com',
      'acme.us.auth0.com/',
      'acme.us.auth0.com/api',
      'acme.us.auth0.com:443',
      'Acme.us.auth0.com',
      'acme',
      '',
      [],
      ['acme.us.auth0.com', 'https://login.acme.example'],
    ]) {
      expect(() => auth0({ domain, audience: 'x' } as Auth0Options), JSON.stringify(domain)).toThrow(
        new TypeError(
          "auth0() takes the tenant's domain as a lowercase host name, such as acme.us.auth0.com: no scheme, port or path."
        )
      );
    }
  });

  it('refuses HS256, which no JWKS can verify, and any algorithm Auth0 does not sign API tokens with', () => {
    for (const algorithms of [['HS256'], ['RS256', 'HS256'], ['ES256'], []]) {
      expect(
        () => auth0({ domain: 'acme.us.auth0.com', audience: 'x', algorithms } as Auth0Options),
        JSON.stringify(algorithms)
      ).toThrow(
        new TypeError(
          'auth0() verifies tokens signed with RS256, RS512 or PS256: an HS256 token is signed with a secret, which no JWKS publishes.'
        )
      );
    }
  });
});

describe('cloudflareAccess()', () => {
  /** What people hold, and one service token. */
  const scopes = {
    people: ['notes:notes:read'],
    services: { '88bf3b6d86161464f6509f7219099e57.access': ['notes:notes:read', 'notes:notes:write'] },
  };

  it("states the Access source, the team's issuer and keys, the AUD tag, RS256 and what callers hold", () => {
    const tokens = cloudflareAccess({ team: 'acme', aud: AUD, organizationId: 'org_acme', scopes });
    expect(tokens).toStrictEqual({
      source: 'cloudflare-access',
      issuer: 'https://acme.cloudflareaccess.com',
      jwksUri: 'https://acme.cloudflareaccess.com/cdn-cgi/access/certs',
      audience: [AUD],
      algorithms: ['RS256'],
      access: { organizationId: 'org_acme', ...scopes },
    });
    expect(jsonRoundTrip(tokens)).toStrictEqual(tokens);
  });

  it('leaves the organization and the service tokens out when the options do, never the development token', () => {
    const tokens = cloudflareAccess({ team: 'acme-staging', aud: AUD, scopes: { people: [] } });
    expect(tokens.access).toStrictEqual({ people: [] });
    expect(jsonRoundTrip(tokens)).toStrictEqual(tokens);
    for (const preset of [tokens, auth0({ domain: 'acme.us.auth0.com', audience: 'x' })]) {
      expect(preset).not.toHaveProperty('development');
    }
  });

  it('refuses a team that is not a team name, and an AUD tag that is not one', () => {
    for (const team of [
      'acme.cloudflareaccess.com',
      'https://acme.cloudflareaccess.com',
      'Acme',
      '-acme',
      '',
    ]) {
      expect(() => cloudflareAccess({ team, aud: AUD, scopes }), team).toThrow(
        new TypeError(
          'cloudflareAccess() takes the Zero Trust team name, such as acme for acme.cloudflareaccess.com.'
        )
      );
    }
    for (const aud of [AUD.toUpperCase(), AUD.slice(1), `${AUD}0`, 'acme', '']) {
      expect(() => cloudflareAccess({ team: 'acme', aud, scopes } as CloudflareAccessOptions), aud).toThrow(
        new TypeError(
          "cloudflareAccess() takes the Access application's AUD tag: 64 lowercase hexadecimal characters."
        )
      );
    }
  });
});
