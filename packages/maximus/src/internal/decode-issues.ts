/**
 * Turns a refused decode into field issues whose paths start at the input's root, as the INVALID_INPUT
 * failure carries them: each of TypeBox's errors at its value's path, a missing or unexpected property at its
 * own, a refused union as one issue, and the issues an owner refinement found at theirs.
 */
import type { TLocalizedValidationError } from 'typebox/error';

import { AssertError } from './value.ts';

/**
 * One refused field: a code, a message that names the expectation and never the value, and the path to the
 * field.
 */
export interface SchemaIssue {
  /** The kind of issue, such as `invalid_input` for a schema mismatch or `custom` for a refinement. */
  code: string;
  /** Why the field was refused, for people; it names the expectation, never the value. */
  message: string;
  /** The keys and array indexes that lead to the refused field; empty when the whole value is refused. */
  path: (string | number)[];
}
/** Every issue of a refused value, as `readSchema` throws it and `checkSchema` returns it. */
export class SchemaValidationError extends TypeError {
  /** Every issue of the refused value; the error's message is the first one's. */
  readonly issues: SchemaIssue[];
  constructor(issues: SchemaIssue[]) {
    super(issues[0]?.message ?? 'The input does not match its schema.');
    this.name = 'SchemaValidationError';
    this.issues = issues;
  }
}

/**
 * What an owner refinement's message starts with when it carries issues of its own, as JSON, or the errors of
 * the schema a pipe reads its value into: TypeBox reports a refinement as one message at the refined value.
 */
const CARRIED = '\u0000maximus:';

/** A refinement's message that carries issues at their paths below the refined value. */
export function carriedIssues(issues: readonly SchemaIssue[]): string {
  return `${CARRIED}${JSON.stringify(issues)}`;
}
/** A refinement's message that carries the errors of another schema, read below the refined value. */
export function carriedErrors(errors: readonly TLocalizedValidationError[]): string {
  return carriedIssues(schemaIssues(errors));
}

/** The segments of a JSON Pointer, unescaped. */
function segments(path: string): string[] {
  return path
    .split('/')
    .slice(1)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
}

/** The issues of a refinement's error at its value's path: those it carries, or its own message. */
function refinementIssues(message: string, path: string[]): SchemaIssue[] {
  if (!message.startsWith(CARRIED)) {
    return [{ code: 'custom', message, path }];
  }
  const carried = JSON.parse(message.slice(CARRIED.length)) as SchemaIssue[];
  return carried.map((issue) => ({ ...issue, path: [...path, ...issue.path] }));
}

/**
 * Field issues for TypeBox's errors, in their order. A missing or an unexpected property is an issue at its own
 * path; a union that matched no member is one issue, its members' errors left out; a refinement is the issues
 * it carries, or its message.
 */
export function schemaIssues(errors: readonly TLocalizedValidationError[]): SchemaIssue[] {
  const unions = errors
    .filter((error) => error.keyword === 'anyOf')
    .map(({ schemaPath }) => `${schemaPath}/anyOf/`);
  const issues: SchemaIssue[] = [];
  for (const error of errors) {
    if (unions.some((union) => error.schemaPath.startsWith(union))) {
      continue;
    }
    const path = segments(error.instancePath);
    if (error.keyword === 'required') {
      for (const name of error.params.requiredProperties) {
        issues.push({ code: 'invalid_input', message: 'must be present', path: [...path, name] });
      }
    } else if (error.keyword === 'additionalProperties') {
      for (const name of error.params.additionalProperties) {
        issues.push({ code: 'invalid_input', message: 'must not be present', path: [...path, name] });
      }
    } else if (error.keyword === '~refine') {
      issues.push(...refinementIssues(error.params.message, path));
    } else if (!(error.keyword === 'boolean' && error.schemaPath.endsWith('/additionalProperties'))) {
      // An unexpected property is refused twice, by `additionalProperties` and by its `false` schema.
      issues.push({ code: 'invalid_input', message: error.message, path });
    }
  }
  return issues;
}

/**
 * The issues of a refused decode, at most `limit`, each with its path from the input's root, or null when
 * nothing refused the input: an owner codec threw something other than a `SchemaValidationError`, which is the
 * codec's fault for the caller to report. TypeBox builds at most as many errors as `internal/value.ts` allows,
 * so an input with millions of them costs no more than a refusal carries.
 */
export function decodeIssues(error: unknown, limit = Number.POSITIVE_INFINITY): SchemaIssue[] | null {
  if (error instanceof SchemaValidationError) {
    return error.issues.slice(0, limit);
  }
  if (error instanceof AssertError) {
    return schemaIssues(error.cause.errors).slice(0, limit);
  }
  return null;
}

/** RFC 6901 JSON Pointer of an issue path; the empty string names the whole input. */
export function jsonPointer(path: readonly (string | number)[]): string {
  return path.map((part) => `/${String(part).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}
