/**
 * Schema validation: the check-only and the decoding validators, the guard that admits only bounded plain
 * JSON, and the RFC format validators registered once with TypeBox.
 */
import { FormatRegistry } from '@sinclair/typebox';
import type { Static, TSchema } from '@sinclair/typebox';
import { Value, HasTransform, TransformDecode } from '@sinclair/typebox/value';
import { fullFormats } from 'ajv-formats/dist/formats.js';

import { SchemaValidationError } from './input-schemas.ts';
import { codecFault, decodeIssues, jsonPointer } from './internal/decode-issues.ts';
import type { StaticDecode } from './schema-types.ts';

// Maintained RFC validators only; never instantiate Ajv or compile dynamic JavaScript in workerd.
for (const name of ['date', 'time', 'date-time', 'email', 'uuid', 'uri'] as const) {
  const format = fullFormats[name];
  const validator = typeof format === 'object' && !(format instanceof RegExp) ? format.validate : format;
  FormatRegistry.Set(name, (value) => {
    if (value.length > 8192) {
      return false;
    }
    if (validator instanceof RegExp) {
      return validator.test(value);
    }
    return typeof validator === 'function' && (validator as (input: string) => unknown)(value) === true;
  });
}

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
 * copy, checks it and runs its codecs. Throws a `SchemaValidationError` (or TypeBox's assertion error) when the
 * input is refused, and whatever an owner codec throws otherwise. Output is checked, never decoded: what a
 * handler returns must already be canonical.
 */
export function decodeSchema<Schema extends TSchema>(schema: Schema, input: unknown): StaticDecode<Schema> {
  if (!boundedInput(input)) {
    throw new SchemaValidationError([
      { code: 'invalid_input', message: 'Input must be a bounded plain JSON tree.', path: [] },
    ]);
  }
  const value = Value.Default(schema, Value.Clone(input));
  Value.Assert(schema, value);
  return (HasTransform(schema, []) ? TransformDecode(schema, [], value) : value) as StaticDecode<Schema>;
}

/** Field issues a refusal carries: enough to correct the input, never an input value. */
export interface InputIssue {
  /** RFC 6901 JSON Pointer to the refused field; empty for the whole input. */
  path: string;
  /** Why the field was refused, for people, at most 256 characters; it never contains the input value. */
  message: string;
}
/** The most field issues one refusal carries. */
const MAX_ISSUES = 10;
/** The longest path or message one issue carries. */
const MAX_ISSUE_TEXT = 256;

/**
 * Decodes input as `decodeSchema` does and answers a refusal as the `INVALID_INPUT` failure, with its first
 * field issues: where the input failed and what was expected, never a value. A fault of an owner codec, an
 * error that refuses nothing, is thrown for the caller to report: it is the server's failure, not the input's.
 */
export function decodeInput<Schema extends TSchema>(schema: Schema, input: unknown) {
  let value: StaticDecode<Schema>;
  try {
    value = decodeSchema(schema, input);
  } catch (error) {
    const refused = decodeIssues(error, MAX_ISSUES);
    if (!refused) {
      throw codecFault(error);
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
  return { ok: true as const, value };
}
