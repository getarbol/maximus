/**
 * Schema validation: the check-only and the decoding validators, the guard that admits only bounded plain
 * JSON, and the RFC format validators registered once with TypeBox.
 */
import { FormatRegistry } from '@sinclair/typebox';
import type { Static, TSchema } from '@sinclair/typebox';
import { Value, HasTransform, TransformDecode } from '@sinclair/typebox/value';
import { fullFormats } from 'ajv-formats/dist/formats.js';

import { decodeIssues, jsonPointer } from './internal/decode-issues.ts';
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

/** TypeBox traversals operate on bounded JSON trees; native RPC must obey the same input boundary as HTTP. */
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
  parents.add(value);
  const valid = Object.values(value).every((child) => boundedInput(child, depth + 1, parents));
  parents.delete(value);
  return valid;
}

/** Admit a real wire schema once, materialize declared defaults, and decode native TypeBox transforms.
 * Output validation deliberately remains check-only: response data must already be canonical. */
export function decodeSchema<Schema extends TSchema>(schema: Schema, input: unknown): StaticDecode<Schema> {
  if (!boundedInput(input)) {
    throw new TypeError('Input must be a bounded plain JSON tree.');
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
 * The transport maps schema codec failures to its declared INVALID_INPUT contract, with the first
 * field issues. Schema messages name the expectation, not the value; owner refinements must too.
 */
export function decodeInput<Schema extends TSchema>(schema: Schema, input: unknown) {
  try {
    return { ok: true as const, value: decodeSchema(schema, input) };
  } catch (error) {
    const issues: InputIssue[] = (decodeIssues(error, MAX_ISSUES) ?? []).map((issue) => ({
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
}
