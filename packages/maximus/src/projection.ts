/**
 * How a service's names and input schemas project onto the surfaces a gateway builds from its OpenAPI
 * document, so the service, the gateway and the gateway's generated clients agree without coordinating:
 * the MCP tool, the CLI's kebab-case words, a permission's description and the typed query codec.
 * Browser-safe: no runtime, no schema library.
 */

export { queryKind } from './internal/query-kind.ts';
export type { QueryKind, SchemaResolver } from './internal/query-kind.ts';

/** A resource and the verb that acts on it, such as `appointments` and `findNearest`. */
export interface ProjectedName {
  /** The resource, in camelCase. */
  readonly resource: string;
  /** The verb, in camelCase. */
  readonly verb: string;
}

/** A camelCase name in kebab-case: `findNearest` is `find-nearest`. */
export function kebab(value: string): string {
  return value.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** A camelCase or kebab-case name in snake_case: `findNearest` and `find-nearest` are `find_nearest`. */
export function snake(value: string): string {
  return value.replaceAll('-', '_').replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * What a permission lets a person do, read from its scope: `integrations:service-accounts:write` is
 * "Write service accounts". A description the service declares wins over it; one operation's title
 * never stands in, since a permission covers several operations.
 */
export function permissionDescription(scope: string): string {
  const [, ...segments] = scope.split(':');
  const action = segments.at(-1) ?? scope;
  const subject = segments.slice(0, -1).join(' ').replaceAll('-', ' ');
  return `${action.charAt(0).toUpperCase()}${action.slice(1)} ${subject}`;
}

/**
 * The MCP tool name a gateway gives an operation, `<namespace>_<resource>_<verb>` in snake_case: the
 * namespace `scheduling` with `{ resource: 'appointments', verb: 'findNearest' }` is
 * `scheduling_appointments_find_nearest`. A name that is not portable across MCP clients and model providers
 * (`^[a-z][a-z0-9_]{0,63}$`) throws a TypeError.
 */
export function mcpToolName(namespace: string, name: ProjectedName): string {
  const tool = `${snake(namespace)}_${snake(name.resource)}_${snake(name.verb)}`;
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool)) {
    throw new TypeError(`MCP tool name ${tool} is not portable.`);
  }
  return tool;
}
