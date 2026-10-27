/**
 * Token presets for `maximus({ tokens })`: what the tokens of an identity provider need, as the plain data
 * that the generated modules carry. Spread one to add what it leaves out, such as `development` or `claims`.
 */
import type { TokenAlgorithm } from '../tokens.ts';
import type { TokenOptions } from './options.ts';

/** The algorithms Auth0 signs an API's access tokens with that a JWKS publishes the keys of. */
export type Auth0Algorithm = Extract<TokenAlgorithm, 'RS256' | 'RS512' | 'PS256'>;

/** What `auth0()` takes: the tenant's domain, the API's audience and its signing algorithms. */
export interface Auth0Options {
  /**
   * The tenant's domain, such as `acme.us.auth0.com`, or its custom domain: a host name without a scheme,
   * port or path. For a tenant whose tokens may name either, list both, the canonical one first.
   */
  domain: string | readonly [string, ...string[]];
  /** The API's identifier, which its access tokens carry as their audience, or several. */
  audience: string | readonly string[];
  /** The algorithms the API signs its access tokens with, as its settings name them; `['RS256']` by default. */
  algorithms?: readonly Auth0Algorithm[];
}

/** What `cloudflareAccess()` takes: the team, the Access application and what its callers hold. */
export interface CloudflareAccessOptions {
  /** The Zero Trust team name: `acme` for `acme.cloudflareaccess.com`. */
  team: string;
  /** The Access application's Application Audience (AUD) tag, from its overview in the dashboard. */
  aud: string;
  /**
   * The organization every caller acts in. Leave it out to read each caller's from a claim, named as
   * `claims.organization` beside the preset, such as `custom.org_id` for a custom OIDC claim.
   */
  organizationId?: string;
  /** The scopes callers hold: every person Access lets through, and each service token by its client id. */
  scopes: {
    /** The scopes every person Access lets through holds. */
    people: readonly string[];
    /** The scopes of each service token, by its client id (`<id>.access`); one not listed holds none. */
    services?: Readonly<Record<string, readonly string[]>>;
  };
}

/** A host name in lowercase: labels of letters, digits and inner hyphens, joined by dots. */
const HOST_NAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** Every algorithm `Auth0Algorithm` names. */
const AUTH0_ALGORITHMS: ReadonlySet<string> = new Set<Auth0Algorithm>(['RS256', 'RS512', 'PS256']);
/** A Zero Trust team name: one lowercase label of letters, digits and inner hyphens. */
const TEAM_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** An Access application's AUD tag: 64 lowercase hexadecimal characters. */
const AUD_TAG = /^[0-9a-f]{64}$/;

/**
 * The token options of an API whose access tokens Auth0 issues: its issuer, `https://<domain>/` with the
 * trailing slash of Auth0's `iss`, its audience and its algorithms. The JWKS, the endpoints and the claims
 * keep their defaults, which are Auth0's. Throws a TypeError for a domain that is not a lowercase host name,
 * such as one with a scheme or a path, and for an algorithm other than RS256, RS512 and PS256: HS256 tokens
 * are signed with a secret, which no JWKS publishes.
 */
export function auth0({ domain, audience, algorithms = ['RS256'] }: Auth0Options): TokenOptions {
  const domains: readonly string[] = typeof domain === 'string' ? [domain] : domain;
  if (!domains.length || domains.some((name) => typeof name !== 'string' || !HOST_NAME.test(name))) {
    throw new TypeError(
      "auth0() takes the tenant's domain as a lowercase host name, such as acme.us.auth0.com: no scheme, port or path."
    );
  }
  if (!algorithms.length || algorithms.some((name) => !AUTH0_ALGORITHMS.has(name))) {
    throw new TypeError(
      'auth0() verifies tokens signed with RS256, RS512 or PS256: an HS256 token is signed with a secret, which no JWKS publishes.'
    );
  }
  return {
    issuer: typeof domain === 'string' ? `https://${domain}/` : domains.map((name) => `https://${name}/`),
    audience,
    algorithms,
  };
}

/**
 * The token options of an application behind Cloudflare Access: the application token Access sets in
 * `Cf-Access-Jwt-Assertion`, read from there alone and verified against the team's keys (RS256, issued by
 * `https://<team>.cloudflareaccess.com`) for the application's AUD tag, and the scopes `scopes` grants. A
 * production build pins the Worker to its origin, so no request reaches it around Access. Throws a TypeError
 * for a team that is not a team name, such as the team's domain, and an AUD tag that is not 64 lowercase
 * hexadecimal characters.
 */
export function cloudflareAccess({
  team,
  aud,
  organizationId,
  scopes,
}: CloudflareAccessOptions): TokenOptions {
  if (typeof team !== 'string' || !TEAM_NAME.test(team)) {
    throw new TypeError(
      'cloudflareAccess() takes the Zero Trust team name, such as acme for acme.cloudflareaccess.com.'
    );
  }
  if (typeof aud !== 'string' || !AUD_TAG.test(aud)) {
    throw new TypeError(
      "cloudflareAccess() takes the Access application's AUD tag: 64 lowercase hexadecimal characters."
    );
  }
  const issuer = `https://${team}.cloudflareaccess.com`;
  return {
    source: 'cloudflare-access',
    issuer,
    jwksUri: `${issuer}/cdn-cgi/access/certs`,
    audience: [aud],
    algorithms: ['RS256'],
    access: {
      ...(organizationId === undefined ? {} : { organizationId }),
      people: scopes.people,
      ...(scopes.services === undefined ? {} : { services: scopes.services }),
    },
  };
}
