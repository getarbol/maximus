/**
 * The type a schema decodes to: TypeBox's `StaticDecode`, which reads each codec's decoded type and is
 * `Static` everywhere else. And the keywords Maximus reads of a schema, which TypeBox leaves out of its types.
 */
import type { TSchema } from 'typebox';

export type { StaticDecode } from 'typebox';

/**
 * A schema's JSON Schema keywords, as Maximus reads them to publish, route and check a contract. TypeBox 1.x
 * types a schema without its options, so a service reads one through this view:
 * `(schema as SchemaKeywords).pattern`.
 */
export interface SchemaKeywords extends TSchema {
  $id?: string;
  type?: string | string[];
  description?: string;
  default?: unknown;
  properties?: Record<string, SchemaKeywords>;
  required?: string[];
  additionalProperties?: boolean | SchemaKeywords;
  patternProperties?: Record<string, SchemaKeywords>;
  items?: SchemaKeywords | SchemaKeywords[];
  anyOf?: SchemaKeywords[];
  allOf?: SchemaKeywords[];
  oneOf?: SchemaKeywords[];
  minProperties?: number;
  maxProperties?: number;
  $ref?: string;
  $defs?: Record<string, SchemaKeywords>;
  pattern?: string;
  format?: string;
  minLength?: number;
  maxLength?: number;
}
