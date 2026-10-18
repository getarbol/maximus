/**
 * Reads untrusted data, such as a stored record or a provider's or a model's answer, through a schema's
 * owner semantics.
 */
import type { StaticDecode, TSchema } from '@sinclair/typebox';

import { inputSchema, SchemaValidationError } from './input-schemas.ts';
import { decodeIssues } from './internal/decode-issues.ts';
import { decodeSchema } from './validation.ts';

/**
 * What `checkSchema` answers: the decoded data, `StaticDecode<S>` (which is `Static<S>` unless `S` holds a
 * TypeBox transform), or the error that lists every issue.
 */
export type Checked<S extends TSchema> =
  | { success: true; data: StaticDecode<S>; error?: never }
  | { success: false; error: SchemaValidationError; data?: never };

/**
 * Reads untrusted data — a stored record, a provider or model answer — through its schema's owner
 * semantics: defaults applied, normalizers run before their checks, unknown keys of a strip object
 * dropped. A refusal carries every issue with its path; nothing is coerced.
 */
export function checkSchema<S extends TSchema>(schema: S, input: unknown): Checked<S> {
  try {
    return { success: true, data: decodeSchema(inputSchema(schema, { stripUnknown: true }), input) };
  } catch (error) {
    const issues = decodeIssues(error);
    if (!issues) {
      throw error;
    }
    return { success: false, error: new SchemaValidationError(issues) };
  }
}

/** `checkSchema`, throwing its SchemaValidationError on refusal. */
export function readSchema<S extends TSchema>(schema: S, input: unknown): StaticDecode<S> {
  const checked = checkSchema(schema, input);
  if (!checked.success) {
    throw checked.error;
  }
  return checked.data;
}
