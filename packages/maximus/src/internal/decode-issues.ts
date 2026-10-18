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
 * The issues of a failed decode, at most `limit`, each with its path from the input's root, or null
 * when the failure is not the input's (an owner codec's own fault is rethrown by the caller). TypeBox
 * finds issues one at a time, so an input with millions of them costs no more than `limit`.
 */
export function decodeIssues(error: unknown, limit = Number.POSITIVE_INFINITY): SchemaIssue[] | null {
  let cause = error;
  let path: string[] = [];
  while (cause instanceof TransformDecodeError) {
    path = segments(cause.path);
    cause = cause.error;
  }
  if (cause instanceof SchemaValidationError) {
    return cause.issues.slice(0, limit).map((issue) => ({ ...issue, path: [...path, ...issue.path] }));
  }
  if (cause instanceof AssertError) {
    const issues: SchemaIssue[] = [];
    for (const issue of cause.Errors()) {
      issues.push({ code: 'invalid_input', message: issue.message, path: segments(issue.path) });
      // Stop before asking for one more: each issue TypeBox finds is built in full.
      if (issues.length >= limit) {
        break;
      }
    }
    return issues;
  }
  if (cause instanceof TypeError) {
    return [{ code: 'invalid_input', message: cause.message, path: [] }];
  }
  return null;
}

/** RFC 6901 JSON Pointer of an issue path; the empty string names the whole input. */
export function jsonPointer(path: readonly (string | number)[]): string {
  return path.map((part) => `/${String(part).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}
