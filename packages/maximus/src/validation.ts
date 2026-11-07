/**
 * Schema validation: the check-only and the decoding validators and the guard that admits only bounded plain
 * JSON, on TypeBox as `internal/value.ts` configures it.
 */
import type { Static, TSchema } from 'typebox';

import { SchemaValidationError } from './input-schemas.ts';
import { decodeIssues, jsonPointer } from './internal/decode-issues.ts';
import { DecodeUnsafe, HasCodec, MAX_ISSUES, Value } from './internal/value.ts';
import type { StaticDecode } from './schema-types.ts';

/**
 * Checks a value against a schema without decoding it: the value when it matches, else an `INVALID_INPUT`
 * failure without issues. Use `decodeInput` for input with defaults and codecs.
 */
export function parseInput<Schema extends TSchema>(schema: Schema, input: unknown) {
  if (Value.Check(schema, input)) {
    return { ok: true as const, value: input };
  }
  return {
    ok: false as const,
    error: {
      code: 'INVALID_INPUT' as const,
      message: 'The input does not match its schema.',
      retryable: false,
      data: {},
    },
  };
}

/** Checks a value against a schema and returns it typed, or throws a TypeError that names no value. */
export function parseSchema<Schema extends TSchema>(schema: Schema, input: unknown): Static<Schema> {
  if (!Value.Check(schema, input)) {
    throw new TypeError('Value does not match its schema');
  }
  return input;
}

/**
 * Whether a value is a bounded plain JSON tree, which TypeBox's traversals expect and every transport admits:
 * no cycles, class instances, functions, non-finite numbers, nesting beyond 100 levels or own `__proto__` key.
 */
function boundedInput(value: unknown, depth = 0, parents = new Set<object>()): boolean {
  if (depth > 100) {
    return false;
  }
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value !== 'object' || parents.has(value)) {
    return false;
  }
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    return false;
  }
  // JSON.parse keeps "__proto__" as an own key, and copying it by assignment would make it the copy's
  // prototype, whose keys no strict schema sees: plain JSON data never needs it.
  if (Object.hasOwn(value, '__proto__')) {
    return false;
  }
  parents.add(value);
  const valid = Object.values(value).every((child) => boundedInput(child, depth + 1, parents));
  parents.delete(value);
  return valid;
}

/**
 * Decodes input against its schema: admits only a bounded plain JSON tree, applies the declared defaults to a
 * copy, checks it, refinements included, and runs its codecs. Throws a `SchemaValidationError` (or TypeBox's
 * assertion error) when the input is refused, and whatever an owner codec throws otherwise. Output is checked,
 * never decoded: what a handler returns must already be canonical.
 */
export function decodeSchema<Schema extends TSchema>(schema: Schema, input: unknown): StaticDecode<Schema> {
  return admitSchema(schema, input).value;
}

/** Decodes input as `decodeSchema` does, and also answers what the schema checked, before any codec ran. */
function admitSchema<Schema extends TSchema>(
  schema: Schema,
  input: unknown
): { value: StaticDecode<Schema>; checked: unknown } {
  if (!boundedInput(input)) {
    throw new SchemaValidationError([
      { code: 'invalid_input', message: 'Input must be a bounded plain JSON tree.', path: [] },
    ]);
  }
  const checked: unknown = Value.Default(schema, Value.Clone(input));
  Value.Assert(schema, checked);
  return {
    // Decoding changes objects in place: what the schema checked stays as it was checked.
    value: (HasCodec(schema)
      ? DecodeUnsafe({}, schema, Value.Clone(checked))
      : checked) as StaticDecode<Schema>,
    checked,
  };
}

/** Field issues a refusal carries: enough to correct the input, never an input value. */
export interface InputIssue {
  /** RFC 6901 JSON Pointer to the refused field; empty for the whole input. */
  path: string;
  /** Why the field was refused, for people, at most 256 characters; it never contains the input value. */
  message: string;
}
/** The longest path or message one issue carries. */
const MAX_ISSUE_TEXT = 256;

/**
 * Decodes input as `decodeSchema` does and answers a refusal as the `INVALID_INPUT` failure, with its first
 * field issues: where the input failed and what was expected, never a value. A fault of an owner codec, an
 * error that refuses nothing, is thrown for the caller to report: it is the server's failure, not the input's.
 */
export function decodeInput<Schema extends TSchema>(schema: Schema, input: unknown) {
  const admitted = admitInput(schema, input);
  return admitted.ok ? { ok: true as const, value: admitted.value } : admitted;
}

/**
 * `decodeInput`, also answering, for an admitted input, `checked`: the plain JSON its schema checked before any
 * codec ran, the one shape the schema's own keywords describe.
 */
export function admitInput<Schema extends TSchema>(schema: Schema, input: unknown) {
  let admitted: { value: StaticDecode<Schema>; checked: unknown };
  try {
    admitted = admitSchema(schema, input);
  } catch (error) {
    const refused = decodeIssues(error, MAX_ISSUES);
    if (!refused) {
      throw error;
    }
    const issues: InputIssue[] = refused.map((issue) => ({
      path: jsonPointer(issue.path).slice(0, MAX_ISSUE_TEXT),
      message: issue.message.slice(0, MAX_ISSUE_TEXT),
    }));
    return {
      ok: false as const,
      error: {
        code: 'INVALID_INPUT' as const,
        message: 'The input does not match its schema.',
        retryable: false,
        data: { issues },
      },
    };
  }
  return { ok: true as const, value: admitted.value, checked: admitted.checked };
}
