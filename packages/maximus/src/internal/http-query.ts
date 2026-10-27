/**
 * The typed GET query codec: which input fields travel in the query string, and how each value is read as
 * its kind.
 */
import { operationPathParameters } from '../http-paths.ts';
import type { OperationShape } from '../manifest.ts';
import { isRecord } from './record.ts';

/** How one input field travels in a query string. */
export type QueryKind = 'string' | 'integer' | 'number' | 'boolean' | 'list';

/** An integer as a query value: no leading zeros and at most 16 digits, so it stays exact. */
const INTEGER = /^-?(?:0|[1-9]\d{0,15})$/;
/** A decimal number as a query value, with an optional exponent. */
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * How one input field travels in a query string, or null when it cannot: objects and nested lists
 * do not. Lists are comma separated; a `null` alternative is not expressible and is ignored.
 */
function queryKind(value: unknown): QueryKind | null {
  if (!isRecord(value)) {
    return null;
  }
  let branches: unknown[] | null = null;
  if (Array.isArray(value.anyOf)) {
    branches = value.anyOf;
  } else if (Array.isArray(value.oneOf)) {
    branches = value.oneOf;
  }
  if (branches) {
    const kinds = branches
      .filter((branch) => !(isRecord(branch) && branch.type === 'null'))
      .map((branch) => queryKind(branch));
    if (!kinds.length || kinds.includes(null)) {
      return null;
    }
    if (kinds.includes('list')) {
      return kinds.every((kind) => kind === 'list' || kind === 'string') ? 'list' : null;
    }
    return kinds.every((kind) => kind === kinds[0]) ? (kinds[0] ?? null) : null;
  }
  if (value.type === 'array') {
    return queryKind(value.items) === 'string' ? 'list' : null;
  }
  if (
    value.type === 'string' ||
    typeof value.const === 'string' ||
    (Array.isArray(value.enum) && value.enum.every((entry) => typeof entry === 'string'))
  ) {
    return 'string';
  }
  return value.type === 'integer' || value.type === 'number' || value.type === 'boolean' ? value.type : null;
}

/** A GET's query fields and the kind each one is read as: every input field outside the path. */
export function queryKinds(op: OperationShape): ReadonlyMap<string, QueryKind> {
  const path = new Set(op.http ? operationPathParameters(op.http.path) : []);
  const kinds = new Map<string, QueryKind>();
  for (const [field, schema] of Object.entries(op.input.properties ?? {})) {
    const kind = path.has(field) ? null : queryKind(schema);
    if (kind) {
      kinds.set(field, kind);
    }
  }
  return kinds;
}

/**
 * A GET's input from its query string, each declared field read once as its kind, the way generated
 * clients write it: `?limit=2&active=true&tags=a,b` is
 * `{ limit: 2, active: true, tags: ['a', 'b'] }`. A field the input does not declare stays a string for
 * the schema to judge. Null when a field repeats, is named `__proto__` or does not read as its kind.
 */
export function queryInput(
  kinds: ReadonlyMap<string, QueryKind>,
  params: URLSearchParams
): Record<string, unknown> | null {
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) {
    return null;
  }
  const input: Record<string, unknown> = {};
  for (const [key, text] of params) {
    // Assigning "__proto__" would set the input's prototype rather than a field no schema declares.
    if (key === '__proto__') {
      return null;
    }
    let value: unknown = text;
    switch (kinds.get(key)) {
      case 'integer': {
        value = INTEGER.test(text) ? Number(text) : null;
        break;
      }
      case 'number': {
        value = NUMBER.test(text) && Number.isFinite(Number(text)) ? Number(text) : null;
        break;
      }
      case 'boolean': {
        value = text === 'true' || text === 'false' ? text === 'true' : null;
        break;
      }
      case 'list': {
        const items = text.split(',');
        value = items.every(Boolean) ? items : null;
        break;
      }
      default: {
        break;
      }
    }
    if (value === null) {
      return null;
    }
    input[key] = value;
  }
  return input;
}
