/**
 * OAuth protected-resource metadata (RFC 9728): the resources an application publishes and the document
 * that describes each one.
 */

/**
 * One OAuth protected resource an application publishes (`tokens.resources`), described by its
 * configuration and never by the request's host.
 */
export interface OAuthResource<E = unknown> {
  /**
   * The resource identifier clients request tokens for, an HTTPS URL, or a function of the env that answers
   * it.
   */
  audience: string | ((env: E) => string);
  /**
   * The authorization servers that issue tokens for the resource, HTTPS URLs without a query, or a function
   * of the env that answers them. Publishing them changes nothing about how tokens are verified.
   */
  authorizationServers: readonly string[] | ((env: E) => readonly string[]);
  /** The scopes the document lists as `scopes_supported`, which may differ from the operations' scopes. */
  scopes: readonly string[];
}

/** A scope token as RFC 6749 defines it: printable ASCII without spaces, quotes or backslashes. */
const SCOPE = /^[\u0021\u0023-\u005B\u005D-\u007E]+$/;

/** Whether a value is an HTTPS URL without credentials or a fragment, and, for an issuer, without a query. */
function httpsIdentifier(value: string, issuer: boolean): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' && !url.username && !url.password && !url.hash && (!issuer || !url.search)
    );
  } catch {
    return false;
  }
}

/**
 * The RFC 9728 document of one resource: its `resource`, `authorization_servers`, `bearer_methods_supported`
 * (`header`) and `scopes_supported`, read from configuration and the env, never from the request. It throws a
 * TypeError when the audience or an issuer is not an HTTPS URL without credentials or a fragment (an issuer
 * also without a query), when no issuer is named, or when a scope is malformed.
 */
export function protectedResourceMetadata<E>(resource: OAuthResource<E>, env: E) {
  const audience = typeof resource.audience === 'function' ? resource.audience(env) : resource.audience;
  const servers =
    typeof resource.authorizationServers === 'function'
      ? resource.authorizationServers(env)
      : resource.authorizationServers;
  if (
    !httpsIdentifier(audience, false) ||
    !servers.length ||
    servers.some((server) => !httpsIdentifier(server, true)) ||
    resource.scopes.some((scope) => !SCOPE.test(scope))
  ) {
    throw new TypeError('OAuth discovery requires HTTPS resource and issuer identifiers and valid scopes.');
  }
  return {
    resource: audience,
    authorization_servers: [...new Set(servers)],
    bearer_methods_supported: ['header'],
    scopes_supported: [...new Set(resource.scopes)],
  };
}
