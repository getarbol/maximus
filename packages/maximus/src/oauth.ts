/**
 * OAuth protected-resource metadata (RFC 9728): the resources an application publishes and the document
 * that describes each one.
 */

/** One OAuth resource published by an application, independent of its deployment hostname. */
export interface OAuthResource<E = unknown> {
  /** Exact audience clients request from the authorization server. */
  audience: string | ((env: E) => string);
  /** Verified issuer identifiers; this declaration does not change token verification. */
  authorizationServers: readonly string[] | ((env: E) => readonly string[]);
  /** OAuth grants supported by the owner, which may differ from internal operation scopes. */
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

/** Serialize RFC 9728 metadata without publishing credentials or accepting request-derived authority. */
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
