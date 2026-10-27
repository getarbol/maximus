/**
 * The input boundary every transport shares: format validators never see more than 8 KiB, decoding admits
 * only bounded plain JSON trees (no cycles, class instances, functions, non-finite numbers or nesting beyond
 * 100 levels, while a value shared by two fields is still a tree), and a refusal carries field issues,
 * never a value or the text of an owner codec's own error.
 */
import { expect, it } from 'vite-plus/test';

import { t } from '../../src/index.ts';
import { decodeInput, decodeSchema, inputSchema, parseInput, transformSchema } from '../../src/schemas.ts';

const BOUNDED = 'Input must be a bounded plain JSON tree.';

/** `leaf` inside `depth` arrays. */
function nested(depth: number): unknown {
  let value: unknown = 'leaf';
  for (let level = 0; level < depth; level += 1) {
    value = [value];
  }
  return value;
}

it('refuses a format-checked value longer than 8 KiB before its validator runs', () => {
  const Uri = t.String({ format: 'uri' });
  const prefix = 'https://example.test/';
  expect(parseInput(Uri, `${prefix}${'x'.repeat(8192 - prefix.length)}`).ok).toBe(true);
  expect(parseInput(Uri, `${prefix}${'x'.repeat(8193 - prefix.length)}`).ok).toBe(false);
  const Email = t.String({ format: 'email' });
  expect(parseInput(Email, `${'a'.repeat(100)}@example.test`).ok).toBe(true);
  expect(parseInput(Email, `${'a'.repeat(8192)}@example.test`).ok).toBe(false);
});

it('decodes only bounded plain JSON trees', () => {
  const anything = t.Unknown();
  expect(decodeSchema(anything, nested(100))).toEqual(nested(100));
  expect(() => decodeSchema(anything, nested(101))).toThrow(new TypeError(BOUNDED));
  const cyclic: Record<string, unknown> = { name: 'loop' };
  cyclic.self = cyclic;
  const unbounded = [
    cyclic,
    [cyclic],
    new Date(0),
    { at: new Date(0) },
    new Map([['key', 'value']]),
    () => 'value',
    { run: () => 'value' },
    1n,
    Symbol('value'),
    Number.NaN,
    [1, Number.POSITIVE_INFINITY],
  ];
  for (const value of unbounded) {
    expect(() => decodeSchema(anything, value), String(typeof value)).toThrow(new TypeError(BOUNDED));
  }
  // One value under two fields is no cycle, and a record without a prototype is plain data.
  const shared = { recordId: 'r1' };
  expect(decodeSchema(anything, { first: shared, second: shared })).toEqual({
    first: shared,
    second: shared,
  });
  const bare = Object.assign(Object.create(null) as Record<string, unknown>, { name: 'Ana' });
  expect(decodeSchema(t.Object({ name: t.String() }), bare)).toEqual({ name: 'Ana' });
});

it('refuses an unbounded input as a whole, and never answers with the text of an owner codec error', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(decodeInput(t.Unknown(), cyclic)).toEqual({
    ok: false,
    error: {
      code: 'INVALID_INPUT',
      message: 'The input does not match its schema.',
      retryable: false,
      data: { issues: [{ path: '', message: BOUNDED }] },
    },
  });
  const Faulty = inputSchema(
    t.Object(
      {
        name: transformSchema(t.String(), () => {
          throw new RangeError('FAULT_SENTINEL at db.internal:5432');
        }),
      },
      { additionalProperties: false }
    )
  );
  const refused = decodeInput(Faulty, { name: 'Ana' });
  expect(refused).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', data: { issues: [] } } });
  expect(JSON.stringify(refused)).not.toContain('SENTINEL');
});
