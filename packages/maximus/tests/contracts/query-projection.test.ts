/**
 * How an input field travels in a query string, at the edges of `queryKind`: `oneOf` alternatives, a null
 * alternative set aside, alternatives that cannot travel together, arrays of anything but text, and
 * reference chains followed through the resolver to a bounded depth.
 */
import { expect, it } from 'vite-plus/test';

import { queryKind } from '../../src/projection.ts';

it('reads oneOf alternatives as anyOf ones, setting a null alternative aside', () => {
  expect(queryKind({ oneOf: [{ type: 'integer' }, { type: 'null' }] })).toBe('integer');
  expect(queryKind({ oneOf: [{ const: 'open' }, { enum: ['done', 'closed'] }] })).toBe('string');
  expect(queryKind({ oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] })).toBe(
    'list'
  );
});

it('refuses a field whose alternatives cannot travel together in a query string', () => {
  const refused = [
    // Nothing but null, or no alternative at all.
    { anyOf: [{ type: 'null' }] },
    { anyOf: [] },
    // An alternative that cannot travel, a list beside a number, and text beside a number.
    { anyOf: [{ type: 'string' }, { type: 'object' }] },
    { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'integer' }] },
    { anyOf: [{ type: 'string' }, { type: 'integer' }] },
    { oneOf: [{ type: 'integer' }, { type: 'number' }] },
    // Lists of numbers or of lists, mixed enums and constants that are not text.
    { type: 'array', items: { type: 'integer' } },
    { type: 'array', items: { type: 'array', items: { type: 'string' } } },
    { enum: ['open', 1] },
    { const: 1 },
    'string',
  ];
  for (const schema of refused) {
    expect(queryKind(schema), JSON.stringify(schema)).toBeNull();
  }
});

it('follows a chain of references through the resolver, and ends a cycle instead of following it', () => {
  const components: Record<string, unknown> = {
    Flag: { $ref: '#/components/schemas/Toggle' },
    Toggle: { type: 'boolean' },
  };
  const resolve = (reference: string) => components[reference.slice('#/components/schemas/'.length)];
  expect(queryKind({ $ref: '#/components/schemas/Flag' }, resolve)).toBe('boolean');
  expect(queryKind({ anyOf: [{ $ref: '#/components/schemas/Flag' }, { type: 'null' }] }, resolve)).toBe(
    'boolean'
  );
  let resolutions = 0;
  const cycle = (reference: string) => {
    resolutions += 1;
    return { $ref: reference };
  };
  expect(queryKind({ $ref: '#/components/schemas/Loop' }, cycle)).toBeNull();
  expect(resolutions).toBe(17);
});
