/**
 * Safe error descriptions: no messages, record keys, cyclic causes or hostile getters reach a diagnostic.
 */
import { expect, it } from 'vitest';

import { createDiagnostics } from '../src/internal/diagnostics.ts';

it('does not serialize messages, record keys, cyclic causes or hostile getters', () => {
  const diagnostics = createDiagnostics(['ValidationError']);
  const error = Object.assign(new Error('PRIVATE'), {
    name: 'ValidationError',
    issues: [{ path: ['PRIVATE'] }],
  });
  error.cause = error;
  error.stack = 'ValidationError: PRIVATE\n    at PRIVATE (worker.js:5:6)';
  expect(diagnostics.describeError(error)).toEqual({
    name: 'ValidationError',
    issueCount: 1,
    locations: [{ line: 5, column: 6 }],
  });
  expect(
    diagnostics.describeError(
      new Proxy(
        {},
        {
          get() {
            throw new Error('PRIVATE');
          },
          has() {
            throw new Error('PRIVATE');
          },
        }
      )
    )
  ).toEqual({ name: 'NonError' });
  expect(diagnostics.safeErrorName({ name: 'PRIVATE' })).toBe('UnknownError');
});
