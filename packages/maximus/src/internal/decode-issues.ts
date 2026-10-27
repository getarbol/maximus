/**
 * Turns a failed TypeBox decode into field issues whose paths start at the input's root, as the
 * INVALID_INPUT failure carries them.
 */
import { AssertError, TransformDecodeError } from '@sinclair/typebox/value';

import { SchemaValidationError } from '../input-schemas.ts';
import type { SchemaIssue } from '../input-schemas.ts';

/** The segments of a JSON Pointer, unescaped. */
function segments(path: string): string[] {
  return path
    .split('/')
    .slice(1)
    .filter(Boolean)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
}

/**
 * The issues of a refused decode, at most `limit`, each with its path from the input's root, or null when
 * nothing refused the input: an owner codec threw something other than a `SchemaValidationError`, which is
 * the codec's fault for the caller to report. A codec nested in another reports its issues below the path
 * the outer one decodes. TypeBox finds issues one at a time, so an input with millions of them costs no
 * more than `limit`.
 */
export function decodeIssues(error: unknown, limit = Number.POSITIVE_INFINITY): SchemaIssue[] | null {
  let cause = error;
  const path: string[] = [];
  while (cause instanceof TransformDecodeError) {
    path.push(...segments(cause.path));
    cause = cause.error;
  }
  if (cause instanceof SchemaValidationError) {
    return cause.issues.slice(0, limit).map((issue) => ({ ...issue, path: [...path, ...issue.path] }));
  }
  if (cause instanceof AssertError) {
    const issues: SchemaIssue[] = [];
    for (const issue of cause.Errors()) {
      issues.push({
        code: 'invalid_input',
        message: issue.message,
        path: [...path, ...segments(issue.path)],
      });
      // Stop before asking for one more: each issue TypeBox finds is built in full.
      if (issues.length >= limit) {
        break;
      }
    }
    return issues;
  }
  return null;
}

/**
 * What an owner codec threw, without the TypeBox error that wraps it: that wrapper carries the value being
 * decoded, which a fault must never take with it to a log.
 */
export function codecFault(error: unknown): unknown {
  let cause = error;
  while (cause instanceof TransformDecodeError) {
    cause = cause.error;
  }
  return cause;
}

/** RFC 6901 JSON Pointer of an issue path; the empty string names the whole input. */
export function jsonPointer(path: readonly (string | number)[]): string {
  return path.map((part) => `/${String(part).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}
