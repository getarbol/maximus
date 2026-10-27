/**
 * The input boundary every transport shares: format validators never see more than 8 KiB, decoding admits
 * only bounded plain JSON trees (no cycles, class instances, functions, non-finite numbers, nesting beyond
 * 100 levels or own `__proto__` key, while a value shared by two fields is still a tree), a refusal carries
 * field issues and never a value, and an owner codec that fails is the server's error, never the input's.
 */
import { expect, it, vi } from 'vite-plus/test';

import { executeOperation } from '../../src/execution.ts';
import { defineErrors, maximus, ok, standardErrors, t } from '../../src/index.ts';
import {
  checkSchema,
  decodeInput,
  decodeSchema,
  inputSchema,
  parseInput,
  SchemaValidationError,
  transformSchema,
} from '../../src/schemas.ts';

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
  expect(() => decodeSchema(anything, nested(101))).toThrow(SchemaValidationError);
  expect(() => decodeSchema(anything, nested(101))).toThrow(BOUNDED);
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
    expect(() => decodeSchema(anything, value), String(typeof value)).toThrow(BOUNDED);
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

it('refuses an unbounded input as a whole, with the issue at its root', () => {
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
});

/** A body whose own `__proto__` key would otherwise become the decoded copy's prototype. */
const PROTOTYPE_BODY = '{"title":"x","__proto__":{"archived":true}}';
const Note = t.Object({ title: t.String() }, { additionalProperties: false });

it('refuses an own __proto__ key at any depth instead of adopting it as the prototype', () => {
  const refusals = [
    JSON.parse(PROTOTYPE_BODY),
    JSON.parse(`{"notes":[${PROTOTYPE_BODY}]}`),
    JSON.parse(`{"note":${PROTOTYPE_BODY}}`),
  ];
  for (const value of refusals) {
    expect(decodeInput(t.Unknown(), value), JSON.stringify(value)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', data: { issues: [{ path: '', message: BOUNDED }] } },
    });
  }
  // Stored or provider data read through a schema is refused the same way.
  expect(checkSchema(Note, JSON.parse(PROTOTYPE_BODY)).success).toBe(false);
  // A key that merely contains the word is ordinary data.
  expect(decodeInput(t.Unknown(), JSON.parse('{"__proto__x":1,"proto":2}')).ok).toBe(true);
});

it('reports an owner codec that fails as the server error it is, without its text, before the handler runs', async () => {
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
  // A TypeError is no refusal either: only a SchemaValidationError or a schema mismatch refuses input.
  const Typed = inputSchema(
    t.Object(
      {
        currency: transformSchema(t.String(), (value) => {
          throw new TypeError(`Unsupported currency ${value}`);
        }),
      },
      { additionalProperties: false }
    )
  );
  expect(() => decodeInput(Faulty, { name: 'Ana' })).toThrow(RangeError);
  expect(() => decodeInput(Typed, { currency: 'CURRENCY_SENTINEL' })).toThrow(TypeError);
  const handler = vi.fn(async () => ok({ done: true }));
  const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const app = maximus({
    name: 'codecs',
    namespace: 'codecs',
    title: 'Codecs',
    version: '1',
    origin: 'https://example.test',
    tokens: { issuer: 'https://issuer.example.test/', audience: 'codecs' },
    errors: defineErrors({}),
    rpc: { callers: ['internal'] },
  })
    .operation(
      'convertCurrency',
      {
        scope: 'codecs:currencies:write',
        title: 'Convert',
        description: 'Convert a currency.',
        effect: 'write',
        input: Typed,
        output: t.Object({ done: t.Boolean() }, { additionalProperties: false }),
        rpc: true,
      },
      handler
    )
    .build();
  const principal = {
    actorId: 'service',
    actorKind: 'service' as const,
    organizationId: 'org_1234567890abcdef',
    requestId: '00000000-0000-4000-8000-000000000001',
  };
  const result = await executeOperation(app, app.operations.convertCurrency, {}, principal, {
    currency: 'CURRENCY_SENTINEL',
  });
  expect(result).toEqual({ ok: false, error: standardErrors.internal.create() });
  expect(handler).not.toHaveBeenCalled();
  expect(report).toHaveBeenCalledOnce();
  expect(JSON.stringify(report.mock.calls)).not.toContain('CURRENCY_SENTINEL');
  report.mockRestore();
});
