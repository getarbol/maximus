/**
 * Owner codecs compiled by inputSchema(): literal unions; strict, loose, stripping and extended objects;
 * normalizers (chained, and on nullable text) before their checks; transforms after them; inspections and
 * refinements with the owner's messages; URL checks; pipes from a wire shape to a canonical one; tuples and
 * records; a separate wire schema; the codec detection `.build()` relies on; and readers that rethrow an
 * owner's own fault. Every refusal names the field and the expectation, never the refused value.
 */
import { expect, it, vi } from 'vite-plus/test';

import { t } from '../../src/index.ts';
import type { Static, TSchema } from '../../src/index.ts';
import { hasUncompiledCodecs } from '../../src/input-schemas.ts';
import {
  SchemaValidationError,
  checkSchema,
  decodeInput,
  defaultSchema,
  extendObject,
  inputSchema,
  inspectSchema,
  literalUnion,
  looseObject,
  normalizeSchema,
  pipeSchema,
  readSchema,
  refineSchema,
  strictObject,
  stripObject,
  transformSchema,
  urlSchema,
} from '../../src/schemas.ts';
import type { SchemaInput, StaticDecode } from '../../src/schemas.ts';

const strict = { additionalProperties: false } as const;
const NORMALIZED = 'The normalized value does not match its schema.';

/** The decoded value, or the refusal's issues as JSON Pointer paths and messages. */
function decode(schema: TSchema, input: unknown) {
  const result = decodeInput(schema, input);
  return result.ok ? { value: result.value } : { issues: result.error.data.issues };
}

it('admits exactly the values of a literal union', () => {
  const Status = literalUnion(['open', 'done', 3, true]);
  const Input = t.Object({ status: Status }, strict);
  for (const status of ['open', 'done', 3, true]) {
    expect(decode(Input, { status }), String(status)).toEqual({ value: { status } });
  }
  for (const status of ['closed', '3', false]) {
    expect(decode(Input, { status }), String(status)).toMatchObject({ issues: [{ path: '/status' }] });
  }
  // @ts-expect-error A value outside the union is not its type either.
  const closed: Static<typeof Status> = 'closed';
  expect(closed).toBe('closed');
});

it('keeps, refuses or drops unknown keys as each object declares, and an extended object keeps its rule', () => {
  const person = t.Object({ name: t.String() });
  const extra = { name: 'Ana', extra: 'EXTRA_SENTINEL' };
  // A read strips unknown keys only from an object that asks for it.
  expect(readSchema(stripObject({ name: t.String() }), extra)).toEqual({ name: 'Ana' });
  expect(readSchema(looseObject(person), extra)).toEqual(extra);
  const refused = checkSchema(strictObject(stripObject({ name: t.String() })), extra);
  expect(refused.error?.issues).toEqual([
    { code: 'invalid_input', message: 'Unexpected property', path: ['extra'] },
  ]);
  expect(JSON.stringify(refused.error?.issues)).not.toContain('EXTRA_SENTINEL');
  // On the wire, where nothing is stripped, a stripping object refuses unknown keys like a strict one.
  expect(decode(inputSchema(stripObject({ name: t.String() })), extra)).toEqual({
    issues: [{ path: '/extra', message: 'Unexpected property' }],
  });
  // Extended, each object keeps how it treats unknown keys, and requires its new fields.
  const stripped = extendObject(stripObject({ name: t.String() }), { age: t.Integer() });
  expect(readSchema(stripped, { ...extra, age: 3 })).toEqual({ name: 'Ana', age: 3 });
  expect(checkSchema(stripped, extra).error?.issues).toEqual([
    expect.objectContaining({ path: ['age'], message: 'Expected required property' }),
    expect.objectContaining({ path: ['age'], message: 'Expected integer' }),
  ]);
  expect(
    checkSchema(extendObject(strictObject(person), { age: t.Integer() }), { ...extra, age: 3 }).success
  ).toBe(false);
  expect(readSchema(extendObject(looseObject(person), { age: t.Integer() }), { ...extra, age: 3 })).toEqual({
    ...extra,
    age: 3,
  });
});

it('normalizes text before its checks, which run after the last normalizer of a run', () => {
  // Trimmed alone, ' AB ' would fail the pattern: the check waits for the lowercase step after it.
  const Code = normalizeSchema(
    normalizeSchema(t.String({ pattern: '^[a-z]{2,4}$' }), (value) => value.trim()),
    (value) => value.toLowerCase()
  );
  const Input = inputSchema(t.Object({ code: Code }, strict));
  expect(decode(Input, { code: ' AB ' })).toEqual({ value: { code: 'ab' } });
  expect(decode(Input, { code: ' CODE_SENTINEL ' })).toEqual({
    issues: [{ path: '/code', message: NORMALIZED }],
  });
  expect(decode(Input, { code: 7 })).toEqual({ issues: [{ path: '/code', message: 'Expected string' }] });
});

it('normalizes a nullable text before its union checks the canonical pattern and length', () => {
  const Code = normalizeSchema(
    t.Union([t.String({ minLength: 2, pattern: '^[a-z]+$' }), t.Null()]),
    (value) => (value === null ? null : value.trim().toLowerCase())
  );
  const Input = inputSchema(t.Object({ code: Code }, strict));
  expect(decode(Input, { code: '  AB ' })).toEqual({ value: { code: 'ab' } });
  expect(decode(Input, { code: null })).toEqual({ value: { code: null } });
  for (const code of ['   ', ' SENTINEL1 ']) {
    const refused = decode(Input, { code });
    expect(refused, code).toEqual({ issues: [{ path: '/code', message: NORMALIZED }] });
    expect(JSON.stringify(refused).toLowerCase()).not.toContain('sentinel');
  }
  expect(decode(Input, { code: 7 })).toEqual({
    issues: [{ path: '/code', message: 'Expected union value' }],
  });
});

it('transforms a value only once its source checks pass, each transform from the previous one', () => {
  const toNumber = vi.fn((value: string) => Math.trunc(Number(value)));
  const Input = inputSchema(
    t.Object({ count: transformSchema(t.String({ pattern: '^[0-9]{1,6}$' }), toNumber) }, strict)
  );
  expect(decode(Input, { count: '42' })).toEqual({ value: { count: 42 } });
  toNumber.mockClear();
  expect(decode(Input, { count: '4x2' })).toEqual({
    issues: [{ path: '/count', message: "Expected string to match '^[0-9]{1,6}$'" }],
  });
  expect(toNumber).not.toHaveBeenCalled();
  // The wire sends the source; the handler receives what the last transform returns.
  const sent: SchemaInput<typeof Input> = { count: '42' };
  // @ts-expect-error The handler never receives the wire's text.
  const received: StaticDecode<typeof Input> = sent;
  expect(received).toEqual({ count: '42' });

  const Words = transformSchema(
    transformSchema(
      normalizeSchema(t.String({ minLength: 1 }), (value) => value.trim()),
      (text) => text.split(/\s+/)
    ),
    (words) => words.length
  );
  expect(decode(inputSchema(t.Object({ words: Words }, strict)), { words: '  one two  three ' })).toEqual({
    value: { words: 3 },
  });
});

it('runs inspections on an admitted value and refuses it with every issue they add, at their paths', () => {
  const inspected = vi.fn();
  const Range = inspectSchema(
    t.Object({ from: t.String({ format: 'date' }), to: t.String({ format: 'date' }) }, strict),
    (range, context) => {
      inspected(range);
      if (range.from > range.to) {
        context.addIssue({ code: 'custom', message: 'The range ends before it starts.', path: ['to'] });
      }
      if (range.from.slice(0, 4) !== range.to.slice(0, 4)) {
        context.addIssue({ code: 'custom', message: 'The range stays within one year.', path: [] });
      }
    }
  );
  const Input = inputSchema(Range);
  expect(decode(Input, { from: '2026-03-01', to: '2026-04-01' })).toEqual({
    value: { from: '2026-03-01', to: '2026-04-01' },
  });
  expect(decode(Input, { from: '2026-03-01', to: '2025-02-01' })).toEqual({
    issues: [
      { path: '/to', message: 'The range ends before it starts.' },
      { path: '', message: 'The range stays within one year.' },
    ],
  });
  inspected.mockClear();
  expect(decode(Input, { from: 'yesterday', to: '2026-04-01' })).toMatchObject({
    issues: [{ path: '/from' }],
  });
  expect(inspected).not.toHaveBeenCalled();
});

it("refines with the owner's message and path, or a generic message, and never names the value", () => {
  const allowed = (value: string) => value !== 'RETIRED_SENTINEL';
  const cases: [TSchema, { path: string; message: string }][] = [
    [
      refineSchema(t.String(), allowed, 'This code is retired.'),
      { path: '', message: 'This code is retired.' },
    ],
    [
      refineSchema(t.String(), allowed, { error: 'This code is retired.' }),
      { path: '', message: 'This code is retired.' },
    ],
    [
      refineSchema(t.String(), allowed, { message: 'Retired.', error: 'Unused.' }),
      { path: '', message: 'Retired.' },
    ],
    [refineSchema(t.String(), allowed, { path: ['code'] }), { path: '/code', message: 'Invalid value' }],
    [refineSchema(t.String(), allowed), { path: '', message: 'Invalid value' }],
  ];
  for (const [schema, issue] of cases) {
    const Input = inputSchema(schema);
    expect(decode(Input, 'active')).toEqual({ value: 'active' });
    const refused = decode(Input, 'RETIRED_SENTINEL');
    expect(refused).toEqual({ issues: [issue] });
    expect(JSON.stringify(refused)).not.toContain('SENTINEL');
  }
});

it('admits a URL only with an allowed protocol and hostname, within its length', () => {
  const Site = inputSchema(
    t.Object(
      { site: urlSchema({ protocol: /^https$/, hostname: /(^|\.)example\.test$/, maxLength: 64 }) },
      strict
    )
  );
  for (const site of ['https://example.test/path', 'https://api.example.test']) {
    expect(decode(Site, { site }), site).toEqual({ value: { site } });
  }
  // Another protocol, another host that only starts like the allowed one, and a URI no URL parser accepts.
  for (const site of [
    'http://example.test',
    'https://example.test.evil.test/',
    'https://example.test:99999/',
  ]) {
    expect(decode(Site, { site }), site).toEqual({ issues: [{ path: '/site', message: 'Invalid value' }] });
  }
  expect(decode(Site, { site: `https://example.test/${'x'.repeat(64)}` })).toEqual({
    issues: [{ path: '/site', message: 'Expected string length less or equal to 64' }],
  });
  expect(decode(Site, { site: 'not a url' })).toEqual({
    issues: [{ path: '/site', message: "Expected string to match 'uri' format" }],
  });
  // Without a hostname pattern or a length, only the protocol is held.
  const Contact = inputSchema(urlSchema({ protocol: /^(https|mailto)$/ }));
  expect(decode(Contact, 'mailto:ana@example.test')).toEqual({ value: 'mailto:ana@example.test' });
  expect(decode(Contact, `https://example.test/${'x'.repeat(100)}`)).toMatchObject({
    value: expect.any(String),
  });
  expect(decode(Contact, 'ftp://example.test/file')).toEqual({
    issues: [{ path: '', message: 'Invalid value' }],
  });
});

it('pipes a wire shape into its canonical schema: the wire checked as the source, the result as the target', () => {
  const Tags = inputSchema(
    pipeSchema(
      transformSchema(t.String({ maxLength: 100 }), (text) => text.split(',')),
      t.Array(
        normalizeSchema(t.String({ minLength: 1, maxLength: 10 }), (tag) => tag.trim().toLowerCase()),
        {
          maxItems: 3,
        }
      )
    )
  );
  // The target's own normalizers run on what the source produced.
  expect(decode(Tags, 'News, Sports ')).toEqual({ value: ['news', 'sports'] });
  expect(decode(Tags, ['news'])).toEqual({ issues: [{ path: '', message: 'Expected string' }] });
  expect(decode(Tags, 'news, ,sports')).toEqual({ issues: [{ path: '/1', message: NORMALIZED }] });
  expect(decode(Tags, 'a,b,c,d')).toEqual({
    issues: [{ path: '', message: 'Expected array length to be less or equal to 3' }],
  });
  // The target's defaults apply to what the source produced.
  const Page = inputSchema(
    pipeSchema(
      transformSchema(t.String({ pattern: '^[0-9]{1,3}$' }), (limit) => ({ limit: Number(limit) })),
      t.Object(
        {
          limit: t.Integer({ maximum: 100 }),
          direction: defaultSchema(literalUnion(['forward', 'backward']), 'forward'),
        },
        strict
      )
    )
  );
  expect(decode(Page, '30')).toEqual({ value: { limit: 30, direction: 'forward' } });
  expect(decode(Page, '300')).toEqual({
    issues: [{ path: '/limit', message: 'Expected integer to be less or equal to 100' }],
  });
  // Inside an object, a wire refusal names the piped field.
  const Filter = inputSchema(
    t.Object({ page: pipeSchema(t.String({ pattern: '^[0-9]+$' }), t.String()) }, strict)
  );
  expect(decode(Filter, { page: 'two' })).toEqual({
    issues: [{ path: '/page', message: "Expected string to match '^[0-9]+$'" }],
  });
});

it('decodes tuple items by position and record values by key', () => {
  const trimmed = normalizeSchema(t.String({ minLength: 1 }), (value) => value.trim());
  const Pair = inputSchema(t.Tuple([trimmed, t.Integer()]));
  expect(decode(Pair, ['  a ', 1])).toEqual({ value: ['a', 1] });
  expect(decode(Pair, ['  ', 1])).toEqual({ issues: [{ path: '/0', message: NORMALIZED }] });
  const Labels = inputSchema(t.Record(t.String(), trimmed));
  expect(decode(Labels, { first: ' x ', second: 'y' })).toEqual({ value: { first: 'x', second: 'y' } });
  expect(decode(Labels, { first: ' ' })).toEqual({ issues: [{ path: '/first', message: NORMALIZED }] });
});

it('reads another wire shape into the canonical schema, its defaults and checks applied after the wire codecs', () => {
  const canonical = t.Object({ limit: defaultSchema(t.Integer({ minimum: 1, maximum: 100 }), 25) }, strict);
  // A query string carries text: the wire reads the number from it.
  const wire = t.Object(
    { limit: t.Optional(transformSchema(t.String({ pattern: '^[0-9]{1,3}$' }), Number)) },
    strict
  );
  const Query = inputSchema(canonical, wire);
  expect(decode(Query, { limit: '30' })).toEqual({ value: { limit: 30 } });
  expect(decode(Query, {})).toEqual({ value: { limit: 25 } });
  expect(decode(Query, { limit: '500' })).toEqual({
    issues: [{ path: '/limit', message: 'Expected integer to be less or equal to 100' }],
  });
  expect(decode(Query, { limit: 30 })).toEqual({ issues: [{ path: '/limit', message: 'Expected string' }] });
});

it('detects a codec only inputSchema() runs below any child, and trusts a compiled subtree', () => {
  const trimmed = normalizeSchema(t.String(), (value) => value.trim());
  const codecs: [string, TSchema][] = [
    ['property', t.Object({ name: trimmed }, strict)],
    ['array item', t.Array(transformSchema(t.String(), (value) => value.length))],
    ['tuple item', t.Tuple([t.String(), inspectSchema(t.Integer(), () => undefined)])],
    ['record value', t.Record(t.String(), refineSchema(t.String(), Boolean))],
    ['union member', t.Union([t.Null(), trimmed])],
    ['intersection member', t.Intersect([t.Object({ name: trimmed }), t.Object({ age: t.Integer() })])],
    ['one-of member', t.Unsafe<string>({ oneOf: [trimmed] })],
    ['pipe', pipeSchema(t.String(), t.String())],
    ['stripping object', stripObject({ name: t.String() })],
  ];
  for (const [where, schema] of codecs) {
    expect(hasUncompiledCodecs(schema), where).toBe(true);
  }
  expect(hasUncompiledCodecs(strictObject(t.Object({ name: t.String() })))).toBe(false);
  expect(
    hasUncompiledCodecs(t.Object({ nested: inputSchema(t.Object({ name: trimmed }, strict)) }, strict))
  ).toBe(false);
  // A schema that contains itself is visited once.
  const tree: { type: string; properties: Record<string, unknown> } = { type: 'object', properties: {} };
  tree.properties.child = tree;
  expect(hasUncompiledCodecs(tree as unknown as TSchema)).toBe(false);
});

it('carries every issue of a refusal and names the first, or the generic refusal when there is none', () => {
  const refusal = new SchemaValidationError([
    { code: 'custom', message: 'The range ends before it starts.', path: ['to'] },
    { code: 'custom', message: 'The range stays within one year.', path: [] },
  ]);
  expect(refusal).toBeInstanceOf(TypeError);
  expect(refusal.name).toBe('SchemaValidationError');
  expect(refusal.message).toBe('The range ends before it starts.');
  expect(refusal.issues).toHaveLength(2);
  expect(new SchemaValidationError([]).message).toBe('The input does not match its schema.');
});

it("rethrows an owner codec's own fault instead of answering it as an issue of the data", () => {
  const Record = t.Object(
    {
      name: transformSchema(t.String(), () => {
        throw new RangeError('The owner codec failed.');
      }),
    },
    strict
  );
  expect(() => checkSchema(Record, { name: 'Ana' })).toThrow('The owner codec failed.');
  expect(() => readSchema(Record, { name: 'Ana' })).toThrow('The owner codec failed.');
  // The data's own mistake is still a refusal with its issues.
  expect(checkSchema(Record, { name: 1 }).error?.issues).toEqual([
    { code: 'invalid_input', message: 'Expected string', path: ['name'] },
  ]);
});
