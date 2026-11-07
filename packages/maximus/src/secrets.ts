/**
 * Secret fields: `secret: true` on a schema marks a value that capture never sends. `withoutSecrets` removes
 * what a schema marks from a value of that schema, at any depth. It runs anywhere, a browser included, and
 * reads the schema's JSON keywords alone: it never checks the value, so no format or codec has to be loaded
 * for it to remove what it must.
 */
import type { TSchema } from 'typebox';

import { isRecord } from './internal/record.ts';
import { SOURCE, STRIP } from './internal/schema-markers.ts';

/** A schema as this module reads it: its keywords, and the markers input codecs leave on it. */
type SchemaNode = Readonly<Record<string, unknown>> & {
  readonly [STRIP]?: boolean;
  readonly [SOURCE]?: unknown;
};
/** What one schema's tree holds, read once: schemas never change. */
interface SchemaTree {
  /** The definitions a `$ref` may name, by name: every `$id` and every `$defs` entry of the tree. */
  definitions: ReadonlyMap<string, readonly SchemaNode[]>;
  /** Whether any node of the tree carries `secret: true`. */
  secret: boolean;
}

/** What `visit` answers for a value that must not stay. */
const REMOVED = Symbol('maximus.schema.removed');
/** Stands for a schema that says nothing about a value, such as an unknown key of a loose object. */
const UNDESCRIBED: SchemaNode = Object.freeze({});
/** Each schema's tree, read on first use. */
const trees = new WeakMap<object, SchemaTree>();
/** Each `patternProperties` key, compiled once: patterns come from schemas, which are finite. */
const patterns = new Map<string, RegExp>();

/** A keyword's value as a list of schemas. */
function schemaList(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A keyword's value as schemas by name. */
function schemaMap(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : {};
}

/** The schemas directly below a schema, whichever keyword holds them. */
function childSchemas(node: SchemaNode): readonly unknown[] {
  return [
    ...Object.values(schemaMap(node.properties)),
    ...Object.values(schemaMap(node.patternProperties)),
    ...Object.values(schemaMap(node.$defs)),
    node.additionalProperties,
    node.additionalItems,
    ...[node.items].flat(),
    ...schemaList(node.anyOf),
    ...schemaList(node.oneOf),
    ...schemaList(node.allOf),
    node[SOURCE],
  ];
}

/** A schema's tree: what `$ref` may name in it, and whether it marks anything secret. */
function treeOf(schema: object): SchemaTree {
  const known = trees.get(schema);
  if (known) {
    return known;
  }
  const definitions = new Map<string, SchemaNode[]>();
  /** Adds one more definition of a name; two of one name both apply. */
  const define = (name: string, node: SchemaNode) => {
    definitions.set(name, [...(definitions.get(name) ?? []), node]);
  };
  let secret = false;
  const seen = new Set<object>();
  const pending: unknown[] = [schema];
  while (pending.length > 0) {
    const node: unknown = pending.pop();
    if (!isRecord(node) || seen.has(node)) {
      continue;
    }
    seen.add(node);
    secret ||= node.secret === true;
    if (typeof node.$id === 'string') {
      define(node.$id, node);
    }
    for (const [name, definition] of Object.entries(schemaMap(node.$defs))) {
      if (isRecord(definition)) {
        define(name, definition);
      }
    }
    pending.push(...childSchemas(node));
  }
  const tree = { definitions, secret };
  trees.set(schema, tree);
  return tree;
}

/** Whether a schema marks any value secret, at any depth. */
export function holdsSecrets(schema: TSchema): boolean {
  return treeOf(schema).secret;
}

/**
 * Adds to `leaves` the schemas a value of `schema` may match, through every reference and union member, and
 * answers false when one of them marks the value secret or names nothing this tree defines: a value that
 * cannot be shown to be clean is removed.
 */
function collectLeaves(schema: unknown, tree: SchemaTree, leaves: SchemaNode[], seen: Set<unknown>): boolean {
  if (seen.has(schema) || !isRecord(schema)) {
    return true;
  }
  seen.add(schema);
  const node: SchemaNode = schema;
  if (node.secret === true) {
    return false;
  }
  const reference = typeof node.$ref === 'string' ? node.$ref.replace('#/$defs/', '') : undefined;
  const targets = reference === undefined ? [] : (tree.definitions.get(reference) ?? []);
  if (reference !== undefined && targets.length === 0) {
    return false;
  }
  const members = [
    ...targets,
    ...schemaList(node.anyOf),
    ...schemaList(node.oneOf),
    ...schemaList(node.allOf),
  ];
  if (!members.every((member) => collectLeaves(member, tree, leaves, seen))) {
    return false;
  }
  if (
    members.length === 0 ||
    node.type !== undefined ||
    node.properties !== undefined ||
    node.patternProperties !== undefined
  ) {
    leaves.push(node);
  }
  return true;
}

/** Whether a schema's `type` admits a value. A TypeBox type outside JSON, such as `Date`, admits anything. */
function typeAdmits(type: unknown, value: unknown): boolean {
  switch (type) {
    case 'string':
    case 'boolean': {
      return typeof value === type;
    }
    case 'number': {
      return typeof value === 'number';
    }
    case 'integer': {
      return Number.isInteger(value);
    }
    case 'null': {
      return value === null;
    }
    case 'array': {
      return Array.isArray(value);
    }
    case 'object': {
      return isRecord(value);
    }
    default: {
      return true;
    }
  }
}

/** Whether a schema holds no opinion on what is inside a value: nothing below it can be marked. */
function describesNothing(leaf: SchemaNode): boolean {
  return (
    leaf.properties === undefined &&
    leaf.patternProperties === undefined &&
    leaf.items === undefined &&
    (leaf.additionalProperties === undefined || leaf.additionalProperties === true) &&
    leaf[STRIP] !== true
  );
}

/** The schemas of an array's element at `position`: a tuple's position, or a list's one schema of items. */
function itemSchemas(leaf: SchemaNode, position: number): readonly unknown[] {
  if (!Array.isArray(leaf.items)) {
    return leaf.items === undefined ? [UNDESCRIBED] : [leaf.items];
  }
  if (position < leaf.items.length) {
    return [leaf.items[position]];
  }
  return isRecord(leaf.additionalItems) ? [leaf.additionalItems] : [];
}

/** A copy of an array without what its schemas mark: a list loses the element, a tuple keeps its positions. */
function visitArray(leaves: readonly SchemaNode[], value: readonly unknown[], tree: SchemaTree): unknown[] {
  const tuple = leaves.some((leaf) => Array.isArray(leaf.items));
  const kept: unknown[] = [];
  for (const [position, element] of value.entries()) {
    const schemas = leaves.flatMap((leaf) => itemSchemas(leaf, position));
    const visited = schemas.length ? visit(schemas, element, tree) : REMOVED;
    if (visited !== REMOVED) {
      kept.push(visited);
    } else if (tuple) {
      kept.push(null);
    }
  }
  return kept;
}

/**
 * The schemas one object schema gives a key: its property and the patterns the key matches, else its
 * additional properties. None when the schema refuses the key: a strict object, or one that strips unknown
 * keys.
 */
function fieldSchemas(leaf: SchemaNode, key: string): readonly unknown[] {
  const declared = [
    ...(Object.hasOwn(schemaMap(leaf.properties), key) ? [schemaMap(leaf.properties)[key]] : []),
    ...Object.entries(schemaMap(leaf.patternProperties))
      .filter(([pattern]) => compiled(pattern).test(key))
      .map(([, schema]) => schema),
  ];
  if (declared.length) {
    return declared;
  }
  if (leaf.additionalProperties === false || leaf[STRIP] === true) {
    return [];
  }
  return isRecord(leaf.additionalProperties) ? [leaf.additionalProperties] : [UNDESCRIBED];
}

/** A pattern of `patternProperties`, compiled once in unicode mode, as TypeBox compiles it to check a value. */
function compiled(pattern: string): RegExp {
  let expression = patterns.get(pattern);
  if (!expression) {
    expression = new RegExp(pattern, 'u');
    patterns.set(pattern, expression);
  }
  return expression;
}

/**
 * A copy of an object without what its schemas mark, nor a key every schema refuses. `Object.fromEntries`
 * keeps an own `__proto__` key a plain key, where assigning it would set the copy's prototype.
 */
function visitObject(
  leaves: readonly SchemaNode[],
  value: Readonly<Record<string, unknown>>,
  tree: SchemaTree
): Record<string, unknown> {
  const kept: [string, unknown][] = [];
  for (const [key, field] of Object.entries(value)) {
    const schemas = leaves.flatMap((leaf) => fieldSchemas(leaf, key));
    const visited = schemas.length ? visit(schemas, field, tree) : REMOVED;
    if (visited !== REMOVED) {
      kept.push([key, visited]);
    }
  }
  return Object.fromEntries(kept);
}

/**
 * A value as these schemas leave it: `REMOVED` when one marks it or none admits it, and otherwise a copy of
 * what they describe. Every schema that may match applies, so a field one union member marks is removed
 * whichever member the value belongs to.
 */
function visit(schemas: readonly unknown[], value: unknown, tree: SchemaTree): unknown {
  const leaves: SchemaNode[] = [];
  const seen = new Set<unknown>();
  if (!schemas.every((schema) => collectLeaves(schema, tree, leaves, seen))) {
    return REMOVED;
  }
  const admitting = leaves.filter((leaf) => typeAdmits(leaf.type, value));
  if (admitting.length === 0) {
    return REMOVED;
  }
  if (admitting.every(describesNothing)) {
    return value;
  }
  if (Array.isArray(value)) {
    return visitArray(admitting, value, tree);
  }
  return isRecord(value) ? visitObject(admitting, value, tree) : value;
}

/**
 * A copy of a value without every field its schema marks with `secret: true`, at any depth: through objects,
 * records, arrays, tuples, unions, intersections, optional fields and references. The input is never changed.
 * A marked list element goes with its value, a marked tuple position becomes `null`, and a schema marked at
 * its root answers `undefined`.
 *
 * Pass a value of the shape the schema describes: what it checked, before any codec ran. It fails closed where
 * a schema cannot speak for a value: a name marked in any member of a union is removed from all of them, a
 * key a strict object refuses is removed, as is a value of another type, or one under a `$ref` the schema does
 * not define.
 */
export function withoutSecrets(schema: TSchema, value: unknown): unknown {
  const kept = visit([schema], value, treeOf(schema));
  return kept === REMOVED ? undefined : kept;
}

/** Keywords whose values are data, never schemas: `secret` inside one is the data's own. */
const DATA_KEYWORDS: ReadonlySet<string> = new Set(['const', 'default', 'enum', 'example', 'examples']);
/** Keywords whose values are named schemas: `secret` directly inside one is a field's name. */
const NAMED_SCHEMAS: ReadonlySet<string> = new Set(['properties', 'patternProperties', '$defs']);

/**
 * A copy of a published schema or document without the `secret` keyword. It tells capture what to leave out,
 * and no client needs it: marking a field changes no OpenAPI document and no tool listing.
 */
export function withoutSecretKeyword(node: unknown, named = false): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => withoutSecretKeyword(item));
  }
  if (!isRecord(node)) {
    return node;
  }
  const kept: [string, unknown][] = [];
  for (const [key, child] of Object.entries(node)) {
    if (named) {
      kept.push([key, withoutSecretKeyword(child)]);
    } else if (DATA_KEYWORDS.has(key) || key.startsWith('x-')) {
      kept.push([key, child]);
    } else if (!(key === 'secret' && child === true)) {
      kept.push([key, withoutSecretKeyword(child, NAMED_SCHEMAS.has(key))]);
    }
  }
  return Object.fromEntries(kept);
}
