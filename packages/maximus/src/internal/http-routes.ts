/**
 * What a route's path says about its operation: the schemas a path parameter has in each variant of its
 * input, and the group the path names.
 */
import type { TSchema } from '@sinclair/typebox';

/**
 * The parameter's schema in an object input, or in each member of a union. Every one must declare the
 * parameter as a required string field, or this throws a TypeError.
 */
export function pathParameterSchemas(input: TSchema, parameter: string): TSchema[] {
  if (input.type === 'object') {
    const schema = input.properties?.[parameter] as TSchema | undefined;
    if (!schema || schema.type !== 'string' || !input.required?.includes(parameter)) {
      throw new TypeError(`Path parameter "${parameter}" must be a required string input field.`);
    }
    return [schema];
  }
  if (Array.isArray(input.anyOf) && input.anyOf.length > 0) {
    return input.anyOf.flatMap((schema: TSchema) => pathParameterSchemas(schema, parameter));
  }
  throw new TypeError('Path parameters require object input contracts.');
}

/**
 * The group a route's path names, which OpenAPI publishes as its tag: its first fixed segment after the
 * version, in words, such as `Notes` for `/v1/notes/{noteId}` and `Task lists` for `/v1/task-lists`;
 * undefined when only parameters follow the version.
 */
export function routeGroup(path: string): string | undefined {
  const segments = path.split('/').filter(Boolean);
  const afterVersion = /^v[1-9][0-9]*$/.test(segments[0] ?? '') ? segments.slice(1) : segments;
  const segment = afterVersion.find((part) => !part.startsWith('{'));
  if (segment === undefined) {
    return undefined;
  }
  const words = segment
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
