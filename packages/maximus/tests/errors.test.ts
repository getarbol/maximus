/**
 * Error catalogs at run time: a domain failure cannot take a standard failure's name or a catalog
 * member's, `create()` checks the data it is given, and `validate()` admits only the catalog's failures.
 */
import { expect, it } from 'vite-plus/test';

import { defineErrors, t } from '../src/index.ts';
import type { ErrorDefinition } from '../src/index.ts';

const errors = defineErrors({
  quotaExceeded: {
    code: 'QUOTA_EXCEEDED',
    status: 429,
    message: 'The organization has reached its quota.',
    retryable: true,
    dataSchema: t.Object({ limit: t.Integer() }, { additionalProperties: false }),
  },
});

it.each(['notFound', 'invalidInput', 'schema', 'definitions', 'status', 'retryAfter', 'validate'])(
  'refuses a domain failure named %s, which would replace a standard failure or hide a factory',
  (name) => {
    // The type refuses these names; a caller without types reaches the run-time refusal.
    const domain: Record<string, ErrorDefinition> = {
      [name]: { code: 'TAKEN_NAME', status: 409, message: 'The name is taken.' },
    };
    expect(() => defineErrors(domain)).toThrow('Domain errors cannot replace');
  }
);

it('builds failures from checked data and validates only its own failures', () => {
  expect(errors.quotaExceeded.create({ limit: 100 })).toEqual({
    code: 'QUOTA_EXCEEDED',
    message: 'The organization has reached its quota.',
    retryable: true,
    data: { limit: 100 },
  });
  expect(() => errors.quotaExceeded.create({ limit: 'many' } as never)).toThrow(TypeError);
  const missing = errors.notFound.create();
  expect(errors.validate(missing)).toEqual(missing);
  expect(errors.status(missing.code)).toBe(404);
  expect(() => errors.validate({ code: 'FOREIGN', message: 'Foreign.', retryable: false, data: {} })).toThrow(
    TypeError
  );
});
