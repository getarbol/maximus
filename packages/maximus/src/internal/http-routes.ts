/**
 * The schemas a path parameter has in each variant of an operation's input.
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
