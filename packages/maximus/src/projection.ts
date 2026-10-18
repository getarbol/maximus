/**
 * How a service's names and input schemas project onto the surfaces a gateway builds from its OpenAPI
 * document, so the service, the gateway and the gateway's generated clients agree without coordinating:
 * the MCP tool, the CLI's kebab-case words, a permission's description and the typed query codec.
 * Browser-safe: no runtime, no schema library.
 */

/** How one input field travels in a query string. */
export type QueryKind = 'string' | 'integer' | 'number' | 'boolean' | 'list';
/** Resolves a local `$ref` (`#/components/schemas/<name>`) of a bundled document. */
export type SchemaResolver = (reference: string) => unknown;
/** A resource and the verb that acts on it, such as `appointments` and `findNearest`. */
export interface ProjectedName {
  /** The resource, in camelCase. */
  readonly resource: string;
  /** The verb, in camelCase. */
  readonly verb: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

/** Portable across MCP clients and model providers (`^[a-z][a-z0-9_]{0,63}$`). */
export function mcpToolName(namespace: string, name: ProjectedName): string {
  const tool = `${snake(namespace)}_${snake(name.resource)}_${snake(name.verb)}`;
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool)) {
    throw new TypeError(`MCP tool name ${tool} is not portable.`);
  }
  return tool;
}

function resolved(schema: unknown, resolve: SchemaResolver | undefined): unknown {
  let value = schema;
  for (let depth = 0; record(value) && typeof value.$ref === 'string'; depth += 1) {
    if (!resolve || depth > 16) {
      return undefined;
    }
    value = resolve(value.$ref);
  }
  return value;
}

/**
 * How one input field travels in a query string, or null when it cannot: objects and nested lists
 * do not. Lists are comma separated; a `null` alternative is not expressible and is ignored.
 */
export function queryKind(schema: unknown, resolve?: SchemaResolver): QueryKind | null {
  const value = resolved(schema, resolve);
  if (!record(value)) {
    return null;
  }
  let branches: unknown[] | null = null;
  if (Array.isArray(value.anyOf)) {
    branches = value.anyOf;
  } else if (Array.isArray(value.oneOf)) {
    branches = value.oneOf;
  }
  if (branches) {
    const kinds = branches
      .filter((branch) => !(record(branch) && branch.type === 'null'))
      .map((branch) => queryKind(branch, resolve));
    if (!kinds.length || kinds.includes(null)) {
      return null;
    }
    if (kinds.includes('list')) {
      return kinds.every((kind) => kind === 'list' || kind === 'string') ? 'list' : null;
    }
    return kinds.every((kind) => kind === kinds[0]) ? (kinds[0] ?? null) : null;
  }
  if (value.type === 'array') {
    return queryKind(value.items, resolve) === 'string' ? 'list' : null;
  }
  if (
    value.type === 'string' ||
    typeof value.const === 'string' ||
    (Array.isArray(value.enum) && value.enum.every((entry) => typeof entry === 'string'))
  ) {
    return 'string';
  }
  return value.type === 'integer' || value.type === 'number' || value.type === 'boolean' ? value.type : null;
}
