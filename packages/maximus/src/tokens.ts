/**
 * Token verification: the principal every operation receives, the token policy, OAuth access token
 * verification against the issuer's JWKS, claim projection, and request admission by scope.
 */
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { createRemoteJWKSet, jwtVerify } from 'jose';

import { standardErrors } from './errors.ts';
import type { Failure } from './errors.ts';
import { sha256Hex } from './internal/digest.ts';
import { isRecord } from './internal/record.ts';
import type { OAuthResource } from './oauth.ts';
import { err, ok } from './result.ts';
import type { Result } from './result.ts';
import { OrganizationIdSchema, UuidSchema } from './schemas.ts';
import { matchesScopes } from './scopes.ts';
import type { ScopeMatch } from './scopes.ts';
import type { BackgroundContext } from './telemetry.ts';
import { parseInput } from './validation.ts';

/**
 * Who calls, as every operation receives it: the actor, its kind, its verified organization and the request
 * id.
 */
export const PrincipalSchema = Type.Object(
  {
    actorId: Type.String({ minLength: 1, maxLength: 255 }),
    actorKind: Type.Union([Type.Literal('user'), Type.Literal('service')]),
    organizationId: OrganizationIdSchema,
    requestId: UuidSchema,
  },
  { additionalProperties: false }
);
/** Who calls: the actor, its kind, its organization and the request id. */
export type Principal = Static<typeof PrincipalSchema>;
/**
 * The OAuth client a token was issued to: its id and its class, `human`, `machine` or `dcr` (a dynamically
 * registered client).
 */
export const TokenClientSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 255 }),
    class: Type.Union([Type.Literal('human'), Type.Literal('machine'), Type.Literal('dcr')]),
  },
  { additionalProperties: false }
);
/** The OAuth client a token was issued to. */
export type TokenClient = Static<typeof TokenClientSchema>;
/**
 * What a verified token grants: the principal without a request id, its scopes and, for an OAuth token, its
 * client. A custom `tokens.resolve` returns this shape.
 */
export const TokenPrincipalSchema = Type.Object(
  {
    ...Type.Omit(PrincipalSchema, ['requestId']).properties,
    scopes: Type.Array(Type.String({ maxLength: 255 }), { maxItems: 1000 }),
    /** Custom resolvers must classify DCR from verified application policy, never request headers. */
    client: Type.Optional(TokenClientSchema),
  },
  { additionalProperties: false }
);
/** What a verified token grants. */
export type TokenPrincipal = Static<typeof TokenPrincipalSchema>;
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
 *   authorization through OAuth.
 */
export type TokenScheme =
  | { type: 'oauth' }
  | { type: 'bearer'; description: string }
  | { type: 'oauth+bearer'; description: string };

/** Request-local authority resolution; callbacks must never retain this context between requests. */
export interface TokenResolutionContext<E = unknown> {
  /** The request's environment bindings, as scoped by `aroundOperation` when it wraps the operation. */
  readonly env: E;
  /** The incoming request being admitted. */
  readonly request: Request;
  /** Where the request arrived: `mcp` at a transport's path, such as `/mcp`, else `http`. */
  readonly surface: 'http' | 'mcp';
  /** Declared application scopes, compiled once; these are capabilities to map, never caller grants. */
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
 * or the application's own `resolve`, the scheme OpenAPI publishes and the OAuth discovery it serves.
 */
export interface TokenPolicy<E = unknown> {
  /**
   * The audience access tokens must carry, or a list of audiences any one of which a token may carry
   * (the service's own and a gateway's in front of it, for example). The first is the canonical
   * resource that OAuth discovery names.
   */
  audience: string | readonly string[];
  /**
   * The OAuth authorization server, an absolute HTTPS URL; the default verification requires it as `iss`.
   * Required unless `scheme.type` is `bearer`.
   */
  issuer?: string;
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
   * subject a machine's carries; the standard claims and Auth0's conventions by default.
   */
  claims?: TokenClaims;
  /**
   * A token accepted from localhost as a developer holding every scope the application declares. A request
   * to any other host never matches, and neither does a token shorter than 32 characters. Never set the
   * token on a deployed Worker.
   */
  development?: TokenDevelopment;
  /** Native Results express expected credential refusals; a raw verified identity remains supported. */
  resolve?: (
    token: string,
    context?: TokenResolutionContext<E>
  ) => Promise<TokenPrincipal | Result<TokenPrincipal, Failure>>;
  /** Absolute discovery URL when a mounted API and its OAuth resource have different origins or paths. */
  resourceMetadataUrl?: string | null | ((context: TokenResolutionContext<E>) => string | null);
  /** Absolute RFC 9728 paths for distinct resources; replaces inferred discovery when configured. */
  resources?: Readonly<Record<string, OAuthResource<E>>>;
  /**
   * How clients obtain tokens, as OpenAPI and discovery publish it: `oauth` (the default), `bearer` for
   * tokens the application issues, or `oauth+bearer` for both.
   */
  scheme?: TokenScheme;
}

/** The hosts only `cf dev`, or a test, reaches a Worker as: the internet never reaches a deployed Worker so. */
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
 * A claim's own value under its name, else at a dotted path through object claims; undefined when absent.
 * Only own properties are read, so no path reaches a prototype.
 */
function claimAt(claims: Record<string, unknown>, path: string): unknown {
  if (Object.hasOwn(claims, path)) {
    return claims[path];
  }
  let value: unknown = claims;
  for (const key of path.split('.')) {
    if (!isRecord(value) || !Object.hasOwn(value, key)) {
      return undefined;
    }
    value = value[key];
  }
  return value;
}

/** A claim's scopes: a space-separated string or a list of strings, none when absent; null when malformed. */
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
 * who holds only the granted scopes their permissions claim also lists. Malformed or inconsistent claims
 * are refused.
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
/** The OAuth authorization server; there is no default, so a deployment always names its own. */
export function tokenIssuer(policy: Pick<TokenPolicy, 'issuer'>): string {
  if (!policy.issuer) {
    throw new TypeError('tokens.issuer is required to verify or document OAuth access tokens.');
  }
  return policy.issuer;
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
 * Refuse, at construction, an OAuth policy that could never verify or document a token. Verification
 * is built lazily, so without this check a missing issuer surfaced only at run time, as a 401 for
 * every token and a 500 for the OpenAPI document. An application that issues its own bearer tokens
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
  >
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
  if (usesOwnBearer(policy)) {
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
  const issuer = tokenIssuer(policy);
  if (
    !httpsUrl(issuer) ||
    [policy.jwksUri, policy.authorizationEndpoint, policy.tokenEndpoint].some(
      (endpoint) => endpoint !== undefined && !httpsUrl(endpoint, issuer)
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

/** A token is accepted when its `aud` names any one of the policy's audiences. */
export function createTokenVerifier<E>(policy: TokenPolicy<E>) {
  const issuer = tokenIssuer(policy);
  const audience = tokenAudiences(policy);
  const uri = new URL(policy.jwksUri ?? '.well-known/jwks.json', issuer);
  if (new URL(issuer).protocol !== 'https:' || uri.protocol !== 'https:') {
    throw new TypeError('Token authority must use HTTPS.');
  }
  const jwks = createRemoteJWKSet(uri, {
    timeoutDuration: 10_000,
    cacheMaxAge: 600_000,
    cooldownDuration: 30_000,
  });
  return async (token: string) => {
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience,
      algorithms: [...(policy.algorithms ?? ['RS256'])],
      clockTolerance: 5,
      requiredClaims: ['exp', 'sub'],
    });
    return payload;
  };
}
/**
 * Admits a request by its bearer token: verifies it (OAuth by JWKS, or the policy's own `resolve`) and checks
 * that it carries the required scope. Refusals are `UNAUTHORIZED` or `FORBIDDEN` failures, never exceptions.
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
  /** Admit the request when its token carries `scope`, or any one of `scope` when it is a list. */
  return async (
    request: Request,
    scope: string | readonly string[],
    context?: TokenResolutionContext<E>,
    scopeMatch: ScopeMatch = 'any'
  ): Promise<Result<TokenPrincipal, Failure>> => {
    const accepted = typeof scope === 'string' ? [scope] : scope;
    /** Whether granted scopes admit the request. */
    const admits = (scopes: readonly string[]) => matchesScopes(accepted, scopes, scopeMatch);
    const bearer =
      policy.resolve || policy.development
        ? /^Bearer (\S+)$/i
        : /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;
    const token = bearer.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!token || token.length > 16_384 || request.headers.has('x-api-key')) {
      return err(standardErrors.unauthorized.create());
    }
    if (
      policy.development &&
      context &&
      (await isDevelopmentToken(policy.development, token, request, context.env))
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
    const principal = projectToken(claims, policy.claims);
    if (!principal.ok) {
      return principal;
    }
    return admits(principal.value.scopes) ? principal : err(standardErrors.forbidden.create());
  };
}
