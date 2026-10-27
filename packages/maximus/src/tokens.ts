/**
 * Token verification: the principal every operation receives, the token policy, OAuth access token
 * verification against the issuer's JWKS, claim projection, and request admission by scope. Cloudflare Access
 * application tokens, which a policy of the `cloudflare-access` source admits, are `cloudflare-access.ts`'s.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';

import {
  ACCESS_TOKEN_HEADER,
  checkAccessPolicy,
  projectAccessToken,
  usesCloudflareAccess,
} from './cloudflare-access.ts';
import { standardErrors } from './errors.ts';
import type { Failure } from './errors.ts';
import { claimAt } from './internal/claims.ts';
import { sha256Hex } from './internal/digest.ts';
import { isRecord } from './internal/record.ts';
import type { OAuthResource } from './oauth.ts';
import { TokenPrincipalSchema } from './principal.ts';
import type { TokenPrincipal } from './principal.ts';
import { err, ok } from './result.ts';
import type { Result } from './result.ts';
import { OrganizationIdSchema } from './schemas.ts';
import { matchesScopes } from './scopes.ts';
import type { ScopeMatch } from './scopes.ts';
import type { BackgroundContext } from './telemetry.ts';
import { parseInput } from './validation.ts';

export { PrincipalSchema, TokenClientSchema, TokenPrincipalSchema } from './principal.ts';
export type { Principal, TokenClient, TokenPrincipal } from './principal.ts';

/**
 * How callers obtain and present the access token, as published in OpenAPI
 * and OAuth discovery.
 *
 * - `oauth` (default): an OAuth 2.0 access token from the issuer. OpenAPI
 *   publishes the authorization-code and client-credentials flows, and
 *   `/.well-known/oauth-protected-resource` names the issuer.
 * - `bearer`: a token the application issues and verifies itself through
 *   `resolve` (a signed visitor session, for example). OpenAPI publishes a
 *   plain HTTP bearer scheme with `description` saying how to obtain one, no
 *   OAuth discovery is served, and a 401 does not point at any. It requires
 *   `resolve` and cannot serve the MCP transport, whose clients discover
 *   authorization through OAuth, nor publish `resources`.
 * - `oauth+bearer`: people present OAuth access tokens and machines bearer
 *   tokens the application verifies, such as workload keys; `resolve`, which
 *   it requires, verifies both. OpenAPI publishes the authorization-code flow
 *   and a bearer scheme with `description`, each operation offering the ones
 *   its `actorKinds` name, which every operation must then declare.
 */
export type TokenScheme =
  | { type: 'oauth' }
  | { type: 'bearer'; description: string }
  | { type: 'oauth+bearer'; description: string };

/**
 * Where a request presents its token: `authorization`, as a bearer token of the `Authorization` header, or
 * `cloudflare-access`, as the application token Cloudflare Access sets in `Cf-Access-Jwt-Assertion` on each
 * request it lets through.
 */
export type TokenSource = 'authorization' | 'cloudflare-access';

/**
 * What a Cloudflare Access application token grants, under the `cloudflare-access` source. Access decides who
 * reaches the application and grants no scope, so the policy states them: every person Access lets through
 * holds `people`, and a service token what `services` lists under its client id. The organization is named
 * once, as `organizationId` or as the claim `claims.organization` names.
 */
export interface TokenAccess {
  /** The organization every caller acts in, when the tokens carry none: an application of one tenant. */
  organizationId?: string;
  /** The scopes every person Access lets through holds, each of the application's namespace. */
  people: readonly string[];
  /**
   * The scopes of each service token, by its client id (`<id>.access`, its token's `common_name`); a service
   * token not listed holds none.
   */
  services?: Readonly<Record<string, readonly string[]>>;
}

/**
 * What `tokens.resolve` and a `tokens.resourceMetadataUrl` function receive about the request being admitted.
 * It belongs to that request: never keep it beyond it.
 */
export interface TokenResolutionContext<E = unknown> {
  /** The request's environment bindings, as scoped by `aroundOperation` when it wraps the operation. */
  readonly env: E;
  /** The incoming request being admitted. */
  readonly request: Request;
  /** Where the request arrived: `mcp` at a transport's path, such as `/mcp`, else `http`. */
  readonly surface: 'http' | 'mcp';
  /**
   * Every scope the application declares (its operations' scopes and conditional scopes, and each transport's
   * scope), for a resolver that maps its own grants onto them. They are what the application can grant, never
   * what the caller holds.
   */
  readonly applicationScopes: readonly string[];
  /**
   * Keeps work running after the response, such as the Worker's `ExecutionContext`; absent when the handler
   * was called without one.
   */
  readonly background?: BackgroundContext;
}

/** The JWS algorithms an issuer may sign access tokens with: asymmetric ones, which a JWKS can verify. */
export type TokenAlgorithm =
  | 'RS256'
  | 'RS384'
  | 'RS512'
  | 'PS256'
  | 'PS384'
  | 'PS512'
  | 'ES256'
  | 'ES384'
  | 'ES512'
  | 'EdDSA';
/** Every algorithm `TokenAlgorithm` names. */
const TOKEN_ALGORITHMS: ReadonlySet<string> = new Set<TokenAlgorithm>([
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
]);
/** The sources a token policy may read tokens from. */
const TOKEN_SOURCES: ReadonlySet<string> = new Set<TokenSource>(['authorization', 'cloudflare-access']);
/**
 * Where an authorization server's access tokens put what the principal needs, and the subject its machines
 * carry, when they differ from the defaults. A claim is named as it is, or by a dotted path into an object
 * claim such as `tenant.id`; a claim whose own name has dots, such as `https://example.com/org_id`, is read
 * as it is named.
 */
export interface TokenClaims {
  /** The claim that holds the caller's organization id; `org_id` by default. */
  organization?: string;
  /**
   * The claim that holds the granted scopes, a space-separated string or a list; `scope` by default (`scp`
   * for Okta, `permissions` for WorkOS session tokens).
   */
  scopes?: string;
  /**
   * The claim that holds the OAuth client id; by default `azp`, else `client_id`, which must agree when both
   * are present (`cid` for Okta).
   */
  client?: string;
  /**
   * The claim that lists what a person may do, a space-separated string or a list; `permissions` by default,
   * as Auth0 issues it with RBAC. A person holds only the granted scopes it also lists, so a token without it
   * grants a person none. `false` trusts the granted scopes alone: set it only for an authorization server
   * that grants each person no more than they may hold, such as Okta with access policies by group, never
   * for one that grants whatever scope a client requests.
   */
  permissions?: string | false;
  /**
   * The subject of a machine's token, given its client id: `{client}@clients` by default, as Auth0 issues
   * them, or `{client}`, the client id itself, as RFC 9068 recommends and Okta and WorkOS issue them. Set
   * `{client}` only when the authorization server assigns every client id, so none can equal a person's
   * subject (RFC 9068, section 5).
   */
  machineSubject?: '{client}@clients' | '{client}';
}

/** A token `vp dev` accepts from localhost, so a service runs without an authorization server. */
export interface TokenDevelopment {
  /**
   * The env binding that holds the token, such as `DEVELOPMENT_TOKEN` set in `.dev.vars`, which `maximus()`
   * declares in development alone; at least 32 characters, or it never matches.
   */
  binding: string;
  /** The organization the developer acts in; `local-development` by default. */
  organizationId?: string;
}

/**
 * How the application verifies bearer tokens: the audiences they must carry, the OAuth issuer and its JWKS,
 * or the application's own `resolve`, the scheme OpenAPI publishes and the OAuth discovery it serves; or,
 * under the `cloudflare-access` source, Cloudflare Access application tokens and what they grant.
 */
export interface TokenPolicy<E = unknown> {
  /**
   * The audience access tokens must carry, or a list of audiences any one of which a token may carry
   * (the service's own and a gateway's in front of it, for example). The first is the canonical
   * resource that OAuth discovery names. Under Cloudflare Access, the application's AUD tag.
   */
  audience: string | readonly string[];
  /**
   * The OAuth authorization server, an absolute HTTPS URL that a token must name as `iss`, or a list of the
   * issuer identifiers one server answers to, such as an Auth0 tenant's own domain and its custom domain. The
   * first is canonical: the authorization server discovery names, and what the JWKS and the endpoints resolve
   * against. Required unless `scheme.type` is `bearer`, or `resolve` verifies Cloudflare Access tokens itself.
   */
  issuer?: string | readonly string[];
  /** The issuer's JWKS URL, resolved against `issuer` and HTTPS only; defaults to `.well-known/jwks.json`. */
  jwksUri?: string;
  /**
   * The authorization endpoint OpenAPI publishes for the authorization-code flow, resolved against `issuer`
   * and HTTPS only; `authorize` by default, as Auth0 serves it. The server's metadata names it as
   * `authorization_endpoint`.
   */
  authorizationEndpoint?: string;
  /**
   * The token endpoint OpenAPI publishes for both flows, resolved against `issuer` and HTTPS only;
   * `oauth/token` by default, as Auth0 serves it. The server's metadata names it as `token_endpoint`.
   */
  tokenEndpoint?: string;
  /** The algorithms the issuer signs access tokens with; `['RS256']` by default. */
  algorithms?: readonly TokenAlgorithm[];
  /**
   * Where the access tokens put the organization, the scopes, the client and a person's permissions, and the
   * subject a machine's carries; the standard claims and Auth0's conventions by default. Under Cloudflare
   * Access, only the organization's claim.
   */
  claims?: TokenClaims;
  /**
   * Where requests present their tokens: `authorization` (the default), as a bearer token, or
   * `cloudflare-access`, as the application token Cloudflare Access sets in `Cf-Access-Jwt-Assertion`, which
   * is then the only place a token is read: never `Authorization`, never the `CF_Authorization` cookie. The
   * development token is a bearer token from localhost under either source. Under `cloudflare-access`, no
   * OAuth discovery is served, a 401 challenges with a plain `Bearer`, writes a browser sends for another
   * site are refused, and no MCP transport can be mounted.
   */
  source?: TokenSource;
  /**
   * What Cloudflare Access application tokens grant under the `cloudflare-access` source: the scopes of a
   * person and of each service token, and the organization every caller acts in. Without it, `resolve`
   * verifies Access tokens itself.
   */
  access?: TokenAccess;
  /**
   * A token accepted from localhost as a developer holding every scope the application declares. A request
   * to any other host never matches, and neither does a token shorter than 32 characters. Never set the
   * token on a deployed Worker.
   */
  development?: TokenDevelopment;
  /**
   * Verifies every token the request presents at the policy's `source` itself, in place of the default
   * verification; only the development token is checked before it. It answers the token's principal, or a
   * failure Result: `FORBIDDEN` answers 403 and any other failure 401. Verify the token cryptographically. A
   * principal that does not match `TokenPrincipalSchema`, a client whose class disagrees with the actor kind
   * (a `machine` client is a `service`), a machine whose actor id is not its client id or
   * `<client id>@clients` (except under `oauth+bearer`), and a thrown error answer `UNAUTHORIZED`. The
   * operation's scopes are then checked against the principal's.
   */
  resolve?: (
    token: string,
    context?: TokenResolutionContext<E>
  ) => Promise<TokenPrincipal | Result<TokenPrincipal, Failure>>;
  /**
   * The protected-resource metadata URL a 401 challenge names, `WWW-Authenticate: Bearer
   * resource_metadata="…"`, when it is not the default document below the base path: a URL, a function of the
   * request that answers one, or `null` for a plain `Bearer` challenge. Set it when the API and its OAuth
   * resource have different origins or paths, and whenever `resources` lists any.
   */
  resourceMetadataUrl?: string | null | ((context: TokenResolutionContext<E>) => string | null);
  /**
   * Protected-resource metadata documents (RFC 9728) to serve instead of the default one, by absolute path
   * at or below `/.well-known/oauth-protected-resource`, one per resource. When set, the default document
   * answers `NOT_FOUND`. A `bearer` scheme cannot set it.
   */
  resources?: Readonly<Record<string, OAuthResource<E>>>;
  /**
   * How clients obtain tokens, as OpenAPI and discovery publish it: `oauth` (the default), `bearer` for
   * tokens the application issues, or `oauth+bearer` for both.
   */
  scheme?: TokenScheme;
}

/** The hosts only `vp dev`, or a test, reaches a Worker as: the internet never reaches a deployed Worker so. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether a token is the development token, presented to a local host. The digests have one length, so the
 * comparison takes the same time however much of the token matches.
 */
async function isDevelopmentToken(
  development: TokenDevelopment,
  token: string,
  request: Request,
  env: unknown
): Promise<boolean> {
  const expected = isRecord(env) ? env[development.binding] : undefined;
  return (
    typeof expected === 'string' &&
    expected.length >= 32 &&
    LOCAL_HOSTS.has(new URL(request.url).hostname) &&
    (await sha256Hex(token)) === (await sha256Hex(expected))
  );
}

/** Whether the application issues its own bearer tokens instead of OAuth access tokens. */
export function usesOwnBearer(policy: Pick<TokenPolicy, 'scheme'>): boolean {
  return policy.scheme?.type === 'bearer';
}

/**
 * A claim that lists values, such as scopes, permissions or grant types: a space-separated string or a list of
 * strings, none when absent; null when malformed.
 */
function scopeList(value: unknown): string[] | null {
  if (value === undefined) {
    return [];
  }
  if (typeof value === 'string') {
    return value.split(' ').filter(Boolean);
  }
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

/**
 * The OAuth client a token names: the mapped claim, else `azp` or `client_id`, which must agree when both are
 * present. Undefined when it names none; null when a client claim is malformed or the two disagree.
 */
function tokenClient(claims: Record<string, unknown>, path: string | undefined): string | null | undefined {
  const named = path === undefined ? [claims.azp, claims.client_id] : [claimAt(claims, path)];
  const present = named.filter((value) => value !== undefined);
  if (present.some((value) => typeof value !== 'string' || !value) || new Set(present).size > 1) {
    return null;
  }
  return present[0] as string | undefined;
}

/**
 * The principal a verified access token grants, read where `mapping` says. A subject of the shape
 * `mapping.machineSubject` names, `<client id>@clients` by default, is a machine; anyone else is a person,
 * who holds only the granted scopes their permissions claim also lists. Malformed or inconsistent claims,
 * such as a missing `sub`, a subject shaped like another client's, or a token of the client credentials grant
 * (`gty: client-credentials`, as Auth0 names it) whose subject is not a machine's, are refused as
 * `UNAUTHORIZED`.
 */
export function projectToken(claims: unknown, mapping: TokenClaims = {}): Result<TokenPrincipal, Failure> {
  const refused = err(standardErrors.unauthorized.create());
  if (!isRecord(claims) || typeof claims.sub !== 'string') {
    return refused;
  }
  const subject = claims.sub;
  const client = tokenClient(claims, mapping.client);
  const granted = scopeList(claimAt(claims, mapping.scopes ?? 'scope'));
  if (client === null || granted === null) {
    return refused;
  }
  const clientsSuffix = mapping.machineSubject !== '{client}';
  const machine = client !== undefined && subject === (clientsSuffix ? `${client}@clients` : client);
  // A subject shaped like a machine's that names another client is forged.
  if (clientsSuffix && !machine && subject.endsWith('@clients')) {
    return refused;
  }
  // A token the client credentials grant issued is a machine's: whatever its subject, it never passes as a
  // person's.
  const grants = scopeList(claimAt(claims, 'gty'));
  if (grants === null || (grants.includes('client-credentials') && !machine)) {
    return refused;
  }
  let scopes = [...new Set(granted)];
  const listed = mapping.permissions ?? 'permissions';
  // Scopes a client requested never authorize a person by themselves: their permissions must list them too.
  if (!machine && listed !== false) {
    const permissions = scopeList(claimAt(claims, listed));
    if (permissions === null) {
      return refused;
    }
    scopes = scopes.filter((scope) => permissions.includes(scope));
  }
  const principal = parseInput(TokenPrincipalSchema, {
    organizationId: claimAt(claims, mapping.organization ?? 'org_id'),
    actorId: subject,
    actorKind: machine ? 'service' : 'user',
    scopes,
    ...(client === undefined ? {} : { client: { id: client, class: machine ? 'machine' : 'human' } }),
  });
  return principal.ok ? ok(principal.value) : refused;
}

/**
 * The issuers a token may name as its `iss`, the canonical one first: the authorization server discovery
 * names, and the one the JWKS and the endpoints resolve against. There is no default, so a deployment always
 * names its own; a missing issuer, an empty one and a repeated one throw a TypeError.
 */
export function tokenIssuers(policy: Pick<TokenPolicy, 'issuer'>): [string, ...string[]] {
  const listed: unknown = policy.issuer;
  const issuers: unknown[] = Array.isArray(listed) ? listed : [listed];
  const valid = issuers.filter((value): value is string => typeof value === 'string' && value !== '');
  const [canonical, ...others] = valid;
  if (canonical === undefined) {
    throw new TypeError('tokens.issuer is required to verify or document OAuth access tokens.');
  }
  if (valid.length !== issuers.length || new Set(valid).size !== valid.length) {
    throw new TypeError(
      'tokens.issuer is one issuer, or a list of distinct issuers, the canonical one first.'
    );
  }
  return [canonical, ...others];
}

/** The canonical OAuth authorization server, the first issuer; a policy without one throws a TypeError. */
export function tokenIssuer(policy: Pick<TokenPolicy, 'issuer'>): string {
  return tokenIssuers(policy)[0];
}

/**
 * The audiences a token may carry, the canonical one first: the `resource` OAuth discovery names.
 * Refuses an empty list, an empty audience and a repeated one.
 */
export function tokenAudiences(policy: Pick<TokenPolicy, 'audience'>): [string, ...string[]] {
  const listed: unknown = policy.audience;
  const audiences: unknown[] = Array.isArray(listed) ? listed : [listed];
  const valid = audiences.filter((value): value is string => typeof value === 'string' && value !== '');
  const [canonical, ...others] = valid;
  if (canonical === undefined || valid.length !== audiences.length || new Set(valid).size !== valid.length) {
    throw new TypeError(
      'tokens.audience must be a non-empty string or a non-empty list of distinct non-empty strings.'
    );
  }
  return [canonical, ...others];
}

/** Whether a value, resolved against `base`, is an HTTPS URL. */
function httpsUrl(value: string, base?: string): boolean {
  try {
    return new URL(value, base).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Refuses, at construction, a token policy that could never verify or document a token: a malformed
 * `development`, an unknown `source`, `access` outside the `cloudflare-access` source, what that source
 * refuses (see `checkAccessPolicy`, which checks its scopes against the application's `namespace`) and,
 * unless the application issues its own bearer tokens or verifies Access tokens itself, an empty or unknown
 * algorithm, a malformed claim mapping, a missing issuer, or an issuer or endpoint that is not an HTTPS URL.
 * Verification is built on first use, so without this check such a policy would fail only at run time, as a
 * 401 for every token and a 500 for the OpenAPI document. An application that issues its own bearer tokens
 * names no authorization server.
 */
export function checkTokenAuthority<E>(
  policy: Pick<
    TokenPolicy<E>,
    | 'issuer'
    | 'jwksUri'
    | 'authorizationEndpoint'
    | 'tokenEndpoint'
    | 'scheme'
    | 'algorithms'
    | 'claims'
    | 'development'
    | 'source'
    | 'access'
    | 'resolve'
    | 'resources'
    | 'resourceMetadataUrl'
  >,
  namespace: string
): void {
  const { development } = policy;
  if (
    development !== undefined &&
    (typeof development.binding !== 'string' ||
      !development.binding ||
      (development.organizationId !== undefined &&
        !parseInput(OrganizationIdSchema, development.organizationId).ok))
  ) {
    throw new TypeError('tokens.development names the binding of its token and a valid organization id.');
  }
  if (policy.source !== undefined && !TOKEN_SOURCES.has(policy.source)) {
    throw new TypeError('tokens.source is authorization or cloudflare-access.');
  }
  const access = usesCloudflareAccess(policy);
  if (policy.access !== undefined && !access) {
    throw new TypeError(
      'tokens.access grants Cloudflare Access callers: set tokens.source to cloudflare-access.'
    );
  }
  if (access) {
    checkAccessPolicy(policy, namespace);
  }
  // Without an issuer, an Access policy's resolver verifies every token itself.
  if (usesOwnBearer(policy) || (access && policy.resolve !== undefined && policy.issuer === undefined)) {
    return;
  }
  const { algorithms, claims } = policy;
  if (
    algorithms !== undefined &&
    (!algorithms.length || algorithms.some((name) => !TOKEN_ALGORITHMS.has(name)))
  ) {
    throw new TypeError('tokens.algorithms lists one or more asymmetric JWS algorithms.');
  }
  if (claims !== undefined) {
    const { permissions, machineSubject } = claims;
    const named = [
      claims.organization,
      claims.scopes,
      claims.client,
      permissions === false ? undefined : permissions,
    ];
    if (
      named.some((path) => path !== undefined && (typeof path !== 'string' || !path)) ||
      (machineSubject !== undefined && !['{client}@clients', '{client}'].includes(machineSubject))
    ) {
      throw new TypeError(
        'tokens.claims names each claim by a non-empty string (permissions may be false), and machineSubject is {client}@clients or {client}.'
      );
    }
  }
  const issuers = tokenIssuers(policy);
  if (
    issuers.some((issuer) => !httpsUrl(issuer)) ||
    [policy.jwksUri, policy.authorizationEndpoint, policy.tokenEndpoint].some(
      (endpoint) => endpoint !== undefined && !httpsUrl(endpoint, issuers[0])
    )
  ) {
    throw new TypeError(
      'tokens.issuer, jwksUri, authorizationEndpoint and tokenEndpoint must be absolute HTTPS URLs, the last three resolved against the issuer.'
    );
  }
}

/** The authorization server's authorization and token endpoints, which OpenAPI publishes. */
export function tokenEndpoints(
  policy: Pick<TokenPolicy, 'issuer' | 'authorizationEndpoint' | 'tokenEndpoint'>
) {
  const issuer = tokenIssuer(policy);
  return {
    authorization: new URL(policy.authorizationEndpoint ?? 'authorize', issuer).href,
    token: new URL(policy.tokenEndpoint ?? 'oauth/token', issuer).href,
  };
}

/**
 * Whether a token's `typ` header lets it be an access token: absent or `JWT`, a plain JWT, else RFC 9068's
 * `at+jwt` (`application/at+jwt` in full), in any case. Any other type, such as `dpop+jwt` or `logout+jwt`,
 * says the issuer's keys signed another kind of token.
 */
function accessTokenType(typ: unknown): boolean {
  if (typ === undefined) {
    return true;
  }
  const type = typeof typ === 'string' ? typ.toLowerCase().replace(/^application\//, '') : '';
  return type === 'jwt' || type === 'at+jwt';
}

/**
 * Verifies OAuth access tokens against the issuer's JWKS and answers their claims, or throws for a token it
 * refuses: the signature by one of the policy's algorithms (`RS256` by default), an `iss` that is one of the
 * policy's issuers, an `aud` that names any one of the policy's audiences, `exp` and `sub`, with five seconds
 * of clock tolerance, and a `typ` header, when the token has one, of a plain JWT or an RFC 9068 access token
 * (`at+jwt`). The JWKS, at `jwksUri` resolved against the first issuer, is fetched within ten seconds and
 * cached for ten minutes. An issuer or JWKS URL that is not HTTPS throws a TypeError at construction.
 */
export function createTokenVerifier<E>(policy: TokenPolicy<E>) {
  const issuers = tokenIssuers(policy);
  const audience = tokenAudiences(policy);
  const uri = new URL(policy.jwksUri ?? '.well-known/jwks.json', issuers[0]);
  if (issuers.some((issuer) => new URL(issuer).protocol !== 'https:') || uri.protocol !== 'https:') {
    throw new TypeError('Token authority must use HTTPS.');
  }
  const jwks = createRemoteJWKSet(uri, {
    timeoutDuration: 10_000,
    cacheMaxAge: 600_000,
    cooldownDuration: 30_000,
  });
  return async (token: string) => {
    const { payload, protectedHeader } = await jwtVerify(token, jwks, {
      issuer: issuers,
      audience,
      algorithms: [...(policy.algorithms ?? ['RS256'])],
      clockTolerance: 5,
      requiredClaims: ['exp', 'sub'],
    });
    if (!accessTokenType(protectedHeader.typ)) {
      throw new Error('The token is typed as another kind of JWT than an access token.');
    }
    return payload;
  };
}

/** The longest token admission reads; a longer one is refused unread. */
const MAX_TOKEN_LENGTH = 16_384;
/** A compact JWS: three base64url segments separated by dots. */
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** Any token: characters other than whitespace. */
const ANY_TOKEN = /^\S+$/;

/** The bearer token of a request's `Authorization` header, `Bearer <token>` in any case of the scheme. */
function bearerToken(request: Request): string | undefined {
  return /^Bearer (\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
}

/**
 * The token a request presents where the policy reads it: the bearer token of `Authorization` or, under the
 * `cloudflare-access` source, the application token of `Cf-Access-Jwt-Assertion` and nothing else. Only a
 * compact JWS is a token, unless the policy's own `resolve` verifies tokens, or, read from `Authorization`,
 * the token may be the development token. Undefined when the request presents none, or one longer than 16384
 * characters.
 */
function presentedToken<E>(
  request: Request,
  policy: Pick<TokenPolicy<E>, 'source' | 'resolve' | 'development'>
): string | undefined {
  const access = usesCloudflareAccess(policy);
  const token = access ? request.headers.get(ACCESS_TOKEN_HEADER) : bearerToken(request);
  const shape = policy.resolve || (policy.development && !access) ? ANY_TOKEN : COMPACT_JWS;
  return token && token.length <= MAX_TOKEN_LENGTH && shape.test(token) ? token : undefined;
}

/**
 * Admits a request by its token: verifies it (the development token, a bearer token from a local host; else
 * the policy's own `resolve` when it has one; else, for OAuth, against the issuer's JWKS, or for Cloudflare
 * Access, against the team's keys, projected by `access`) and checks that its scopes admit the request. The
 * token is the bearer token of `Authorization`, or under the `cloudflare-access` source the application token
 * of `Cf-Access-Jwt-Assertion` alone. A request without a token, with one longer than 16384 characters, or
 * with an `x-api-key` header is refused; without `resolve` (or, for a bearer token, a development token), the
 * token must be a compact JWS. Refusals are `UNAUTHORIZED` or `FORBIDDEN` failures, never exceptions. `given`
 * stands in for the JWKS check in tests, answering a token's claims.
 */
export function createTokenAuthorization<E>(
  policy: TokenPolicy<E>,
  given?: (token: string) => Promise<unknown>
) {
  // Built on first use: an application with its own resolver may never verify an OAuth token itself.
  let verifier = given;
  /** Verifies an OAuth access token, building the verifier on first use. */
  const verify = (token: string) => {
    verifier ??= createTokenVerifier(policy);
    return verifier(token);
  };
  /** The principal a verified token's claims grant: Access's projection, or the OAuth claim mapping. */
  const project = (claims: unknown) =>
    usesCloudflareAccess(policy) ? projectAccessToken(claims, policy) : projectToken(claims, policy.claims);
  /**
   * Admits the request when its token carries `scope` or, for a list, any one of them (every one with
   * `scopeMatch` `all`).
   */
  return async (
    request: Request,
    scope: string | readonly string[],
    context?: TokenResolutionContext<E>,
    scopeMatch: ScopeMatch = 'any'
  ): Promise<Result<TokenPrincipal, Failure>> => {
    const accepted = typeof scope === 'string' ? [scope] : scope;
    /** Whether granted scopes admit the request. */
    const admits = (scopes: readonly string[]) => matchesScopes(accepted, scopes, scopeMatch);
    if (request.headers.has('x-api-key')) {
      return err(standardErrors.unauthorized.create());
    }
    const bearer = bearerToken(request);
    if (
      policy.development &&
      context &&
      bearer &&
      bearer.length <= MAX_TOKEN_LENGTH &&
      (await isDevelopmentToken(policy.development, bearer, request, context.env))
    ) {
      const developer: TokenPrincipal = {
        actorId: 'local-developer',
        actorKind: 'user',
        organizationId: policy.development.organizationId ?? 'local-development',
        scopes: [...context.applicationScopes],
        client: { id: 'local-development', class: 'human' },
      };
      return admits(developer.scopes) ? ok(developer) : err(standardErrors.forbidden.create());
    }
    const token = presentedToken(request, policy);
    if (!token) {
      return err(standardErrors.unauthorized.create());
    }
    if (policy.resolve) {
      try {
        const outcome = await policy.resolve(token, context);
        if ('ok' in outcome && !outcome.ok) {
          return err(
            outcome.error.code === 'FORBIDDEN'
              ? standardErrors.forbidden.create()
              : standardErrors.unauthorized.create()
          );
        }
        const resolved = parseInput(TokenPrincipalSchema, 'ok' in outcome ? outcome.value : outcome);
        if (!resolved.ok) {
          return err(standardErrors.unauthorized.create());
        }
        const { client } = resolved.value;
        if (
          client &&
          ((client.class === 'machine') !== (resolved.value.actorKind === 'service') ||
            (policy.scheme?.type !== 'oauth+bearer' &&
              client.class === 'machine' &&
              resolved.value.actorId !== client.id &&
              resolved.value.actorId !== `${client.id}@clients`))
        ) {
          return err(standardErrors.unauthorized.create());
        }
        return admits(resolved.value.scopes) ? ok(resolved.value) : err(standardErrors.forbidden.create());
      } catch {
        return err(standardErrors.unauthorized.create());
      }
    }
    let claims: unknown;
    try {
      claims = await verify(token);
    } catch {
      return err(standardErrors.unauthorized.create());
    }
    const principal = project(claims);
    if (!principal.ok) {
      return principal;
    }
    return admits(principal.value.scopes) ? principal : err(standardErrors.forbidden.create());
  };
}
