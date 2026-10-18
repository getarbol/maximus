/**
 * Scope names and matching: the namespaced form every scope takes, and whether granted scopes admit a
 * request.
 */

/** Whether a caller needs any one of several scopes (`any`, the default) or all of them. */
export type ScopeMatch = 'any' | 'all';

/** `<namespace>:<resource>:<action>`, or deeper, in lowercase kebab-case segments. */
const SCOPE_NAME = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*){2,}$/;

/** Whether `scope` is a well-formed scope of the service whose namespace is `namespace`. */
export function isNamespacedScope(scope: string, namespace: string): boolean {
  return scope.startsWith(`${namespace}:`) && SCOPE_NAME.test(scope);
}

/**
 * Whether granted scopes admit a requirement: any one of the required scopes, or all of them with `all`.
 * An empty requirement admits nobody.
 */
export function matchesScopes(
  required: readonly string[],
  granted: readonly string[],
  match: ScopeMatch = 'any'
): boolean {
  if (!required.length) {
    return false;
  }
  const has = (scope: string) => granted.includes(scope);
  return match === 'all' ? required.every(has) : match === 'any' && required.some(has);
}
