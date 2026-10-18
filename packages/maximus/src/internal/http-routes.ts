/**
 * The schemas a path parameter has in each variant of an operation's input.
 */
import type { TSchema } from '@sinclair/typebox';

/** Every body variant must declare its path authority as a required string field. */
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
