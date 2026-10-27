/**
 * Cloudflare Access application tokens: where a request presents one, what it grants and what a token policy
 * must state to admit it. Access signs people and service tokens in at Cloudflare's edge, and sets the
 * application token in `Cf-Access-Jwt-Assertion` on each request it lets through. A Worker cannot take that
 * header's presence as proof: a request reaches it around Access at its `workers.dev` and preview URLs, at a
 * path Access does not cover, or through a Service Binding. So every token is verified, its signature, issuer
 * and audience, and nothing else Access sets, such as `Cf-Access-Authenticated-User-Email` or the
 * `CF_Authorization` cookie, is read.
 */
import { standardErrors } from './errors.ts';
import type { Failure } from './errors.ts';
import { claimAt } from './internal/claims.ts';
import { isRecord } from './internal/record.ts';
import { TokenPrincipalSchema } from './principal.ts';
import type { TokenPrincipal } from './principal.ts';
import { err, ok } from './result.ts';
import type { Result } from './result.ts';
import { OrganizationIdSchema } from './schemas.ts';
import { isNamespacedScope } from './scopes.ts';
import type { TokenAccess, TokenPolicy } from './tokens.ts';
import { parseInput } from './validation.ts';

/** The header Access sets the application token in: the only place a policy of its source reads one. */
export const ACCESS_TOKEN_HEADER = 'cf-access-jwt-assertion';

/** Whether a token policy admits Cloudflare Access application tokens, rather than bearer tokens. */
export function usesCloudflareAccess(policy: Pick<TokenPolicy, 'source'>): boolean {
  return policy.source === 'cloudflare-access';
}

/** A caller as an Access application token names it, before the organization joins it. */
type AccessCaller = Omit<TokenPrincipal, 'organizationId'>;

/**
 * The principal a verified Access application token grants under `policy.access`. A person, whose token
 * names them in `sub` and carries no `common_name`, acts as `sub` (never as their email) through a `human`
 * client, the application's audience, and holds `access.people`. A service token, whose token has an empty
 * `sub` and its client id as `common_name`, acts as that client id through a `machine` client of the same
 * id, and holds what `access.services` lists under it, else nothing. Each acts in `access.organizationId`, or
 * in the organization the claim `claims.organization` holds. Anything else is refused as `UNAUTHORIZED`: a
 * token whose `type` is not `app` (an Access organization token, for one), a token that is neither a person's
 * nor a service token's, an organization missing or malformed or named by both, and a policy without `access`.
 */
export function projectAccessToken(
  claims: unknown,
  policy: Pick<TokenPolicy, 'audience' | 'access' | 'claims'>
): Result<TokenPrincipal, Failure> {
  const refused = err(standardErrors.unauthorized.create());
  const { access } = policy;
  if (access === undefined || !isRecord(claims) || claims.type !== 'app') {
    return refused;
  }
  const audience = applicationAudience(claims.aud, policy.audience);
  const caller = audience === undefined ? null : accessCaller(claims, access, audience);
  if (caller === null) {
    return refused;
  }
  const principal = parseInput(TokenPrincipalSchema, {
    ...caller,
    organizationId: accessOrganization(claims, access, policy.claims?.organization),
  });
  return principal.ok ? ok(principal.value) : refused;
}

/**
 * The application audience a token names: the first of the policy's audiences that its `aud`, a string or a
 * list, carries; undefined when it carries none of them.
 */
function applicationAudience(named: unknown, audience: TokenPolicy['audience']): string | undefined {
  const carried: unknown = typeof named === 'string' ? [named] : named;
  if (!Array.isArray(carried)) {
    return undefined;
  }
  const audiences: readonly string[] = typeof audience === 'string' ? [audience] : audience;
  return audiences.find((candidate) => carried.includes(candidate));
}

/**
 * Who a token names: a person by a non-empty `sub` without `common_name`, or a service token by its
 * `common_name` with an empty `sub`; null for a token of any other shape, such as one that carries both.
 */
function accessCaller(
  claims: Record<string, unknown>,
  access: TokenAccess,
  audience: string
): AccessCaller | null {
  const { sub: subject, common_name: commonName } = claims;
  if (typeof subject === 'string' && subject !== '' && commonName === undefined) {
    return {
      actorId: subject,
      actorKind: 'user',
      scopes: [...access.people],
      client: { id: audience, class: 'human' },
    };
  }
  if (subject === '' && typeof commonName === 'string' && commonName !== '') {
    return {
      actorId: commonName,
      actorKind: 'service',
      scopes: serviceScopes(access, commonName),
      client: { id: commonName, class: 'machine' },
    };
  }
  return null;
}

/**
 * The scopes `access.services` lists for a service token's client id, none when it lists none. Only its own
 * entries are read, so no client id reaches a prototype's property.
 */
function serviceScopes(access: TokenAccess, clientId: string): string[] {
  const { services = {} } = access;
  const listed = Object.hasOwn(services, clientId) ? services[clientId] : undefined;
  return [...(listed ?? [])];
}

/**
 * The organization an Access caller acts in: `access.organizationId`, or the value of the claim `claim`
 * names, such as `custom.org_id` for a custom OIDC claim Access passes on. Undefined, and so refused, unless
 * exactly one of them is set.
 */
function accessOrganization(
  claims: Record<string, unknown>,
  access: TokenAccess,
  claim: string | undefined
): unknown {
  if (claim === undefined) {
    return access.organizationId;
  }
  return access.organizationId === undefined ? claimAt(claims, claim) : undefined;
}

/** The options of a token policy that only OAuth access tokens use, which Access application tokens are not. */
const OAUTH_OPTIONS = [
  'scheme',
  'resources',
  'resourceMetadataUrl',
  'authorizationEndpoint',
  'tokenEndpoint',
] as const;
/** The most scopes a principal holds, as `TokenPrincipalSchema` admits them. */
const MAX_SCOPES = 1000;

/**
 * Refuses, at construction, a policy of the `cloudflare-access` source that could never admit a caller, or
 * that states what Access application tokens never carry: neither `access` nor `resolve`; any option only
 * OAuth uses (`scheme`, `resources`, `resourceMetadataUrl` and the endpoints OpenAPI would publish); claims
 * other than the organization; and, with `access`, an organization named twice, not at all or malformed, or
 * scopes outside the application's namespace, more than 1000 of them, or listed under an empty client id.
 */
export function checkAccessPolicy<E>(
  policy: Pick<TokenPolicy<E>, 'access' | 'resolve' | 'claims' | (typeof OAUTH_OPTIONS)[number]>,
  namespace: string
): void {
  const { access, claims } = policy;
  if (access === undefined && policy.resolve === undefined) {
    throw new TypeError(
      'tokens.source cloudflare-access requires tokens.access, or tokens.resolve to verify Access tokens itself.'
    );
  }
  const oauth = OAUTH_OPTIONS.filter((option) => policy[option] !== undefined);
  if (oauth.length) {
    throw new TypeError(
      `Cloudflare Access application tokens are not OAuth access tokens: remove ${oauth.map((option) => `tokens.${option}`).join(', ')}.`
    );
  }
  if (
    claims !== undefined &&
    Object.entries(claims).some(([name, value]) => name !== 'organization' && value !== undefined)
  ) {
    throw new TypeError(
      'Under Cloudflare Access, tokens.claims names the organization alone: tokens.access grants the scopes.'
    );
  }
  if (access === undefined) {
    return;
  }
  const { organizationId } = access;
  const claim = claims?.organization;
  // Exactly one names it: the policy's own organization id, or the claim that holds the caller's.
  const namedOnce =
    claim === undefined
      ? parseInput(OrganizationIdSchema, organizationId).ok
      : organizationId === undefined && typeof claim === 'string' && claim !== '';
  if (!namedOnce) {
    throw new TypeError(
      'Under Cloudflare Access, name a valid organization once: tokens.access.organizationId or tokens.claims.organization.'
    );
  }
  /** Whether a list holds scopes of the application, at most as many and as long as a principal's. */
  const ownScopes = (scopes: unknown) =>
    Array.isArray(scopes) &&
    scopes.length <= MAX_SCOPES &&
    scopes.every(
      (scope) => typeof scope === 'string' && scope.length <= 255 && isNamespacedScope(scope, namespace)
    );
  const services: unknown = access.services ?? {};
  if (
    !ownScopes(access.people) ||
    !isRecord(services) ||
    Object.entries(services).some(
      ([clientId, scopes]) => !clientId || clientId.length > 255 || !ownScopes(scopes)
    )
  ) {
    throw new TypeError(
      `tokens.access grants scopes of ${namespace}:<resource>:<action>, at most ${MAX_SCOPES} to people and to each service token, by its client id.`
    );
  }
}

/** The methods that change nothing: another site's page may send them without consequence. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whether a browser sent a write for another site's page: a method other than `GET`, `HEAD` and `OPTIONS`
 * with `Sec-Fetch-Site: cross-site`, or with an `Origin` other than the request's own. A person's Access
 * session travels in a cookie, which the browser attaches to such a request, and Access forwards it with
 * the person's application token. A request with neither header, such as a service token's, is no browser's.
 */
export function isCrossSiteWrite(request: Request): boolean {
  if (SAFE_METHODS.has(request.method)) {
    return false;
  }
  const origin = request.headers.get('origin');
  return (
    request.headers.get('sec-fetch-site') === 'cross-site' ||
    (origin !== null && origin !== new URL(request.url).origin)
  );
}
