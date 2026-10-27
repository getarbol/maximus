/**
 * Results, catalogs and scopes: which untrusted answers are Results; the catalog refusals of a malformed or
 * repeated code, a status outside 400 to 599 and loose failure data; a code's status and Retry-After; the schema of a
 * Result; and scope matching, which admits nobody for an empty requirement or an unknown match mode and
 * accepts only scopes of the namespace itself.
 */
import { expect, it } from 'vite-plus/test';

import {
  defineErrors,
  err,
  isResult,
  matchesScopes,
  ok,
  parseInput,
  resultSchema,
  standardErrors,
  t,
} from '../../src/index.ts';
import type { ErrorDefinition } from '../../src/index.ts';
import { isNamespacedScope } from '../../src/scopes.ts';

const strict = { additionalProperties: false } as const;
const missing = standardErrors.notFound.create();

it('recognizes a Result only by its value, or by a failure with a code, message, retryability and data', () => {
  const foreign = { code: 'PROVIDER_DOWN', message: 'The provider is down.', retryable: true, data: {} };
  for (const result of [ok(1), ok(undefined), ok(null), err(missing), err(foreign)]) {
    expect(isResult(result), JSON.stringify(result)).toBe(true);
  }
  const malformed = [
    null,
    undefined,
    'ok',
    [ok(1)],
    { ok: true },
    { ok: 'true', value: 1 },
    { ok: false },
    { ok: false, error: 'NOT_FOUND' },
    { ok: false, error: { ...missing, code: 404 } },
    { ok: false, error: { ...missing, message: undefined } },
    { ok: false, error: { ...missing, retryable: 'no' } },
    { ok: false, error: { ...missing, data: [] } },
    { ok: false, error: { ...missing, data: null } },
    { ok: false, error: { code: missing.code, message: missing.message, retryable: false } },
  ];
  for (const answer of malformed) {
    expect(isResult(answer), JSON.stringify(answer)).toBe(false);
  }
});

it('refuses a code that is not uppercase words joined by underscores, as clients and observations read it', () => {
  for (const code of [
    'record-missing',
    'RecordMissing',
    '_MISSING',
    'MISSING RECORD',
    `M${'X'.repeat(81)}`,
  ]) {
    expect(
      () => defineErrors({ missing: { code, status: 404, message: 'The record does not exist.' } }),
      code
    ).toThrow(
      new TypeError(
        `An error code is uppercase words joined by underscores, such as RECORD_NOT_FOUND: ${code}`
      )
    );
  }
  expect(() =>
    defineErrors({
      missing: { code: `R${'X'.repeat(80)}`, status: 404, message: 'The record does not exist.' },
    })
  ).not.toThrow();
});

it('refuses a catalog that repeats a code, answers outside 400 to 599 or declares loose failure data', () => {
  const refused: Record<string, ErrorDefinition>[] = [
    { recordMissing: { code: 'NOT_FOUND', status: 404, message: 'The record does not exist.' } },
    {
      locked: { code: 'LOCKED', status: 423, message: 'The record is locked.' },
      held: { code: 'LOCKED', status: 409, message: 'The record is held.' },
    },
    { moved: { code: 'MOVED', status: 302, message: 'The record moved.' } },
    { beyond: { code: 'BEYOND', status: 600, message: 'Beyond any status.' } },
  ];
  for (const domain of refused) {
    expect(() => defineErrors(domain), Object.keys(domain).join(',')).toThrow(
      new TypeError('Error definitions require unique codes and failure statuses.')
    );
  }
  for (const dataSchema of [t.Object({ limit: t.Integer() }), t.String()]) {
    expect(() =>
      defineErrors({
        quota: {
          code: 'QUOTA',
          status: 429,
          message: 'The quota is reached.',
          dataSchema: dataSchema as never,
        },
      })
    ).toThrow(new TypeError('Domain error data must be a strict object schema.'));
  }
});

it("answers a code's status and Retry-After, and 500 without Retry-After for a code the catalog lacks", () => {
  const errors = defineErrors({
    quota: { code: 'QUOTA', status: 429, message: 'The quota is reached.', retryable: true, retryAfter: 30 },
  });
  expect([errors.status('QUOTA'), errors.retryAfter('QUOTA')]).toEqual([429, 30]);
  expect([errors.status('NOT_FOUND'), errors.retryAfter('NOT_FOUND')]).toEqual([404, undefined]);
  expect([errors.status('UNDECLARED'), errors.retryAfter('UNDECLARED')]).toEqual([500, undefined]);
  expect(errors.quota.is(errors.quota.create())).toBe(true);
  expect(errors.quota.is(missing)).toBe(false);
});

it('describes a Result of one value schema and one error schema, admitting nothing else', () => {
  const schema = resultSchema(t.Object({ recordId: t.String() }, strict), standardErrors.schema);
  for (const result of [ok({ recordId: 'r1' }), err(missing)]) {
    expect(parseInput(schema, result).ok, JSON.stringify(result)).toBe(true);
  }
  const refused = [
    { ok: true, value: { recordId: 1 } },
    { ok: true, value: { recordId: 'r1' }, error: null },
    { ok: false, error: { ...missing, code: 'FOREIGN' } },
    { ok: false, value: { recordId: 'r1' } },
    { ok: true },
  ];
  for (const answer of refused) {
    expect(parseInput(schema, answer).ok, JSON.stringify(answer)).toBe(false);
  }
});

it('admits nobody for an empty requirement or an unknown match mode, and requires every scope only with all', () => {
  const read = 'records:records:read';
  const audit = 'records:audit:read';
  // An empty requirement would hold vacuously under all: it admits nobody.
  expect(matchesScopes([], [read])).toBe(false);
  expect(matchesScopes([], [read], 'all')).toBe(false);
  expect(matchesScopes([read, audit], [audit])).toBe(true);
  expect(matchesScopes([read, audit], [audit], 'all')).toBe(false);
  expect(matchesScopes([read, audit], [audit, read], 'all')).toBe(true);
  expect(matchesScopes([read], [read], 'some' as never)).toBe(false);
});

it('accepts only lowercase scopes of three or more segments under the namespace itself', () => {
  for (const scope of ['records:records:read', 'records:audit-log:read', 'records:records:export:read']) {
    expect(isNamespacedScope(scope, 'records'), scope).toBe(true);
  }
  const refused = [
    'recordsx:records:read',
    'other:records:read',
    'records:read',
    'records:Records:read',
    'records:1records:read',
    'records:records:',
    'records::read',
    ' records:records:read',
  ];
  for (const scope of refused) {
    expect(isNamespacedScope(scope, 'records'), scope).toBe(false);
  }
});
