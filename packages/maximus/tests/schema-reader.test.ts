/**
 * Reading untrusted data: defaults, normalization before checks and unknown keys stripped.
 */
import { expect, it } from 'vitest';

import { checkSchema, defaultSchema, normalizeSchema, readSchema, stripObject, t } from '../src/schemas.ts';

it('reads untrusted data with defaults, normalization before checks and stripped unknown keys', () => {
  const Record = stripObject({
    name: normalizeSchema(t.String({ minLength: 1, maxLength: 5 }), (value) => value.trim()),
    limit: defaultSchema(t.Integer({ minimum: 1, maximum: 3 }), 1),
    confirmed: t.Optional(t.Literal(true)),
  });
  expect(readSchema(Record, { name: '  ana ', extra: 'dropped' })).toEqual({ name: 'ana', limit: 1 });
  const blank = checkSchema(Record, { name: '   ' });
  expect(blank.success).toBe(false);
  const coerced = checkSchema(Record, { name: 'ana', confirmed: 'true' });
  expect(coerced.success).toBe(false);
  expect(coerced.error?.issues[0]?.path).toEqual(['confirmed']);
  expect(() => readSchema(Record, { limit: 9 })).toThrow();
});
