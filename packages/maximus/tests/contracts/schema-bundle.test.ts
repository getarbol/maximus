/**
 * Schema bundling: a reference made outside its definition resolved to the one component its name has, and
 * refused when the name has several shapes; recursive variants that share a name each kept apart; a
 * component name the document already uses suffixed; references to other documents left untouched in a
 * standalone schema; and the shape comparison that sets aside a schema's name and use-site annotations.
 */
import { expect, it } from 'vite-plus/test';

import { t } from '../../src/index.ts';
import type { TSchema } from '../../src/index.ts';
import { bundleSchemas, sameSchema, standaloneSchema } from '../../src/schema-bundle.ts';

const strict = { additionalProperties: false } as const;
const Money = t.Object(
  { amount: t.Integer(), currency: t.String({ pattern: '^[A-Z]{3}$' }) },
  { $id: 'Money', ...strict }
);
/** `Money` as a component holds it: its JSON without its name. */
const money = {
  type: 'object',
  properties: { amount: { type: 'integer' }, currency: { type: 'string', pattern: '^[A-Z]{3}$' } },
  required: ['amount', 'currency'],
  additionalProperties: false,
};
const component = (name: string) => ({ $ref: `#/components/schemas/${name}` });

it('resolves a reference made outside its definition to the one component its name has', () => {
  const Invoice = t.Object({ total: t.Ref('Money'), lines: t.Array(t.Ref('Money')) }, strict);
  const { values, components } = bundleSchemas([Invoice, Money], {});
  expect(values).toEqual([
    {
      type: 'object',
      properties: { total: component('Money'), lines: { type: 'array', items: component('Money') } },
      required: ['total', 'lines'],
      additionalProperties: false,
    },
    component('Money'),
  ]);
  expect(components).toEqual({ Money: money });
});

it('refuses a reference outside any definition when its name has several shapes', () => {
  const Cents = t.Object({ cents: t.Integer() }, { $id: 'Money', ...strict });
  expect(() => bundleSchemas([t.Object({ total: t.Ref('Money') }, strict), Money, Cents], {})).toThrow(
    new TypeError('Schema reference "Money" does not name exactly one definition.')
  );
  // Inside its definition, a recursive schema's reference names its own variant.
  const tree = (leaf: TSchema) =>
    t.Recursive((Self) => t.Object({ leaf, children: t.Array(Self) }, strict), { $id: 'Tree' });
  const { values, components } = bundleSchemas([tree(t.String()), tree(t.Integer())], {});
  expect(values).toEqual([component('Tree'), component('Tree_2')]);
  expect(components).toMatchObject({
    Tree: { properties: { leaf: { type: 'string' }, children: { items: component('Tree') } } },
    Tree_2: { properties: { leaf: { type: 'integer' }, children: { items: component('Tree_2') } } },
  });
});

it('suffixes a component whose name the document already uses, keeping one component per shape', () => {
  const described = { ...Money, description: 'The invoice total.' };
  const { values, components } = bundleSchemas([Money, described], { Money: { type: 'string' } });
  // The use-site description stays beside the reference; the shape is registered once.
  expect(values).toEqual([
    component('Money_2'),
    { ...component('Money_2'), description: 'The invoice total.' },
  ]);
  expect(components).toEqual({ Money_2: money });
});

it('writes a standalone schema with named definitions under $defs and references to other documents untouched', () => {
  const Node = t.Recursive((Self) => t.Object({ children: t.Array(Self) }, strict), { $id: 'Node' });
  const external = 'https://schemas.example.test/address.json';
  const schema = t.Object({ tree: Node, address: t.Unsafe({ $ref: external }) }, strict);
  expect(standaloneSchema(schema)).toEqual({
    type: 'object',
    properties: { tree: { $ref: '#/$defs/Node' }, address: { $ref: external } },
    required: ['tree', 'address'],
    additionalProperties: false,
    $defs: {
      Node: {
        type: 'object',
        properties: { children: { type: 'array', items: { $ref: '#/$defs/Node' } } },
        required: ['children'],
        additionalProperties: false,
      },
    },
  });
  // A name nothing refers to is dropped, the definition written in place.
  expect(standaloneSchema(Money)).toEqual(money);
});

it('compares schemas by shape, setting aside their name and use-site annotations', () => {
  const annotated = {
    ...Money,
    $id: 'Price',
    title: 'Price',
    description: 'A price.',
    examples: [{ amount: 100, currency: 'EUR' }],
    deprecated: true,
  };
  expect(sameSchema(Money, annotated)).toBe(true);
  // TypeBox's symbols and codecs are not part of the shape the JSON carries.
  expect(sameSchema(Money, JSON.parse(JSON.stringify(Money)))).toBe(true);
  expect(sameSchema(Money, { ...Money, additionalProperties: true })).toBe(false);
  expect(sameSchema(Money, t.Object({ cents: t.Integer() }, { $id: 'Money', ...strict }))).toBe(false);
  // Values that are not objects compare as their JSON.
  expect(sameSchema([Money], [annotated])).toBe(false);
  expect(sameSchema(undefined, null)).toBe(true);
  expect(sameSchema('Money', 'Money')).toBe(true);
});
