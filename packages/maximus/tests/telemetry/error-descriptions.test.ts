/**
 * Safe error descriptions in depth: causes are named up to three deep and stop at a cycle, issue counts
 * come from the error or its direct cause, stack locations come only from well-formed frames under the exact
 * heading, and no getter or Proxy can break a description or leak what it guards.
 */
import { expect, it } from 'vite-plus/test';

import { createDiagnostics } from '../../src/internal/diagnostics.ts';

const diagnostics = createDiagnostics(['ProviderError']);

/** An error of a given class name, as a provider SDK or a domain module would throw it. */
function named(name: string, message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), { name });
}

it('names up to three causes, nearest first, each by a known name or generically', () => {
  const error = new TypeError('PRIVATE first', {
    cause: new RangeError('PRIVATE second', {
      cause: named(
        'VendorError',
        'PRIVATE third',
        named('ProviderError', 'PRIVATE fourth', new EvalError('fifth'))
      ),
    }),
  });
  expect(diagnostics.describeError(error)).toMatchObject({
    name: 'TypeError',
    causes: ['RangeError', 'UnknownError', 'ProviderError'],
  });
  const described = diagnostics.describeError(new Error('outer', { cause: 'PRIVATE string cause' }));
  expect(described.causes).toEqual(['UnknownError']);
  expect(JSON.stringify(described)).not.toContain('PRIVATE');
});

it('stops naming causes at a cycle', () => {
  const first = new TypeError('PRIVATE first');
  const second = new RangeError('PRIVATE second', { cause: first });
  first.cause = second;
  expect(diagnostics.describeError(first).causes).toEqual(['RangeError']);
});

it('counts the issues of the error, or else those of its direct cause', () => {
  const cause = Object.assign(new Error('PRIVATE'), { issues: [{ path: ['PRIVATE'] }, { path: ['email'] }] });
  const described = diagnostics.describeError(new TypeError('invalid input', { cause }));
  expect(described.issueCount).toBe(2);
  expect(JSON.stringify(described)).not.toContain('PRIVATE');
});

it('reads stack locations only from well-formed frames under the exact heading, within bounds', () => {
  const error = new TypeError('PRIVATE message');
  error.stack = [
    'TypeError: PRIVATE message',
    '    at readRecord (worker.js:10:5)',
    'PRIVATE line that is not a frame',
    '    at worker.js:0:3',
    '    at huge (worker.js:10000001:1)',
    '    at <anonymous>',
    '    at last (https://example.test/PRIVATE/worker.js:7:8)',
  ].join('\n');
  const described = diagnostics.describeError(error);
  expect(described).toEqual({
    name: 'TypeError',
    locations: [
      { line: 10, column: 5 },
      { line: 7, column: 8 },
    ],
  });
  const deep = new RangeError('deep');
  deep.stack = [
    'RangeError: deep',
    ...Array.from({ length: 12 }, (_, index) => `    at frame${index} (worker.js:${index + 1}:1)`),
  ].join('\n');
  expect(diagnostics.describeError(deep).locations).toHaveLength(8);
});

it('heads the stack of an error without a message by its bare name', () => {
  const bare = new RangeError('PRIVATE');
  bare.message = '';
  bare.stack = 'RangeError\n    at check (worker.js:3:4)';
  expect(diagnostics.describeError(bare)).toEqual({
    name: 'RangeError',
    locations: [{ line: 3, column: 4 }],
  });
});

it('reads no location from a stack under another heading, without frames, or of an error with no name', () => {
  const renamed = new TypeError('PRIVATE');
  renamed.stack = 'Error: PRIVATE\n    at worker.js:1:1';
  expect(diagnostics.describeError(renamed)).toEqual({ name: 'TypeError' });
  const frameless = new TypeError('PRIVATE');
  frameless.stack = 'TypeError: PRIVATE\nPRIVATE detail';
  expect(diagnostics.describeError(frameless)).toEqual({ name: 'TypeError' });
  const nameless = new Error('PRIVATE');
  Object.defineProperty(nameless, 'name', { value: 42 });
  nameless.stack = '42: PRIVATE\n    at worker.js:1:1';
  expect(diagnostics.describeError(nameless)).toEqual({ name: 'UnknownError' });
});

it('never lets a hostile getter or Proxy break a description of an error', () => {
  const hostile = new Error('PRIVATE');
  for (const key of ['name', 'message', 'stack', 'cause', 'issues']) {
    Object.defineProperty(hostile, key, {
      get() {
        throw new Error('PRIVATE getter');
      },
    });
  }
  expect(diagnostics.describeError(hostile)).toEqual({ name: 'UnknownError' });
  const proxied = new Proxy(new TypeError('PRIVATE'), {
    get() {
      throw new Error('PRIVATE trap');
    },
  });
  expect(diagnostics.describeError(proxied)).toEqual({ name: 'UnknownError' });
  expect(diagnostics.safeErrorName(proxied)).toBe('UnknownError');
});
