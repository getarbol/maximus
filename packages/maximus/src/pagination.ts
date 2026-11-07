/**
 * The one list contract: bidirectional keyset pagination. A list takes the query fields `cursor`,
 * `direction` and `limit` and answers `{ object: 'list', data, pageInfo }`. The cursor is opaque to
 * callers; there is no page number, page size, offset or implicit total. `cutPage` cuts such a page from a
 * list a service holds whole.
 *
 * `PageInfo` and each `Page` are named schemas, so an OpenAPI document carries them once as
 * `#/components/schemas/<name>` and every SDK generated from it shares their types.
 */
import { Type } from 'typebox';
import type { Static, TArray, TLiteral, TObject, TProperties, TSchema } from 'typebox';

import { annotate, defaultSchema } from './input-schemas.ts';

/** A public schema name: an SDK type in every language generated from the document. */
const PAGE_ID = /^[A-Z][A-Za-z0-9]{0,127}$/;

/**
 * How to reach a list's neighboring pages: whether they exist and their opaque cursors, named `PageInfo`.
 */
export const PageInfoSchema = Type.Object(
  {
    hasNextPage: Type.Boolean({ description: 'Whether a later page exists in the current ordering.' }),
    hasPreviousPage: Type.Boolean({ description: 'Whether an earlier page exists in the current ordering.' }),
    nextCursor: Type.Union([Type.String(), Type.Null()], {
      description: 'Opaque cursor for the next page, or null when there is none.',
    }),
    previousCursor: Type.Union([Type.String(), Type.Null()], {
      description: 'Opaque cursor for the previous page, or null when there is none.',
    }),
  },
  { $id: 'PageInfo', additionalProperties: false }
);
/** How to reach a list's neighboring pages. */
export type PageInfo = Static<typeof PageInfoSchema>;

/**
 * A list's `limit`: an integer from 1 to `maximum` (100), `default` (25, or the maximum when it is lower)
 * when the caller sends none. A list whose items are costly lowers the maximum:
 * `{ ...PageQueryFields, limit: pageLimit({ maximum: 20 }) }`. A default outside 1 to the maximum, or a
 * value that is not an integer, throws a TypeError.
 */
export function pageLimit(options: { maximum?: number; default?: number } = {}) {
  const { maximum = 100, default: fallback = Math.min(25, maximum) } = options;
  if (!(Number.isInteger(maximum) && Number.isInteger(fallback) && fallback >= 1 && fallback <= maximum)) {
    throw new TypeError('A page limit has an integer default from 1 to its integer maximum.');
  }
  return defaultSchema(
    Type.Integer({
      minimum: 1,
      maximum,
      description: `Maximum items returned in one page. Defaults to ${fallback}; larger reads require another cursor.`,
    }),
    fallback
  );
}

/**
 * The query fields of a list, spread into its input beside its own filters: an optional opaque `cursor`, a
 * `direction` (`forward` by default, or `backward`) and a `limit` (`pageLimit()`).
 */
export const PageQueryFields = {
  cursor: Type.Optional(
    Type.String({ description: 'Opaque cursor returned by pageInfo; omit it to request the first page.' })
  ),
  direction: defaultSchema(
    Type.Union([Type.Literal('forward'), Type.Literal('backward')], {
      description: 'Direction to traverse the stable keyset ordering from the supplied cursor.',
    }),
    'forward'
  ),
  limit: pageLimit(),
} satisfies TProperties;
/** The list query a handler receives, its defaults applied. */
export type PageQuery = Static<TObject<typeof PageQueryFields>>;

/** The TypeBox type of a `Page` of `Item`. */
export type TPage<Item extends TSchema> = TObject<{
  data: TArray<Item>;
  object: TLiteral<'list'>;
  pageInfo: typeof PageInfoSchema;
}>;
/** One page of a list, as a handler returns it. */
export interface Page<Item> {
  /** The items of this page, in the list's stable order. */
  data: Item[];
  /** Always `list`, the discriminator of a list response. */
  object: 'list';
  /** Whether neighboring pages exist, and the opaque cursors that reach them. */
  pageInfo: PageInfo;
}

/**
 * The output of a list of `item`, named by `$id` (`AppointmentPage`), a PascalCase name of up to 128
 * characters; any other throws a TypeError. Give each list its own name and use it for that list only: two
 * different shapes under one `$id` become two components, the second one suffixed `_2`.
 */
export function Page<Item extends TSchema>(item: Item, options: { $id: string }): TPage<Item> {
  if (!PAGE_ID.test(options.$id)) {
    throw new TypeError(`Page "${options.$id}" needs a PascalCase schema name, such as AppointmentPage.`);
  }
  return Type.Object(
    {
      data: Type.Array(item, {
        description: 'Items admitted by this resource contract within the verified organization.',
      }),
      object: Type.Literal('list', { description: 'Discriminator for a resource list response.' }),
      pageInfo: annotate(PageInfoSchema, {
        description: 'Opaque navigation cursors for this page’s stable keyset order.',
      }),
    },
    { $id: options.$id, additionalProperties: false }
  );
}

/** How a list a service holds whole is ordered: by each item's key, compared part by part as text. */
export interface PageOrder<Item> {
  /** The values an item sorts by, which together tell it from every other item, such as `[createdAt, id]`. */
  key: (item: Item) => readonly string[];
  /** `desc` lists the greatest key first, such as the newest; `asc`, the default, the least. */
  order?: 'asc' | 'desc';
}

/** A place between two items of a list: right after the item with this key, or right before it. */
interface Position {
  /** Which side of the item the place is on, in the list's order. */
  side: 'after' | 'before';
  /** The item's key. */
  key: readonly string[];
}

/** The longest cursor `cutPage` reads: keys are short identifiers, dates and names. */
const MAX_CURSOR_LENGTH = 4096;
/** A cursor's text: unpadded base64url. */
const CURSOR_TEXT = /^[A-Za-z0-9_-]+$/;

/** Two keys, part by part, in code unit order: the same in every runtime, whatever its locale. */
function compareKeys(left: readonly string[], right: readonly string[]): number {
  for (const [index, part] of left.entries()) {
    const other = right[index] ?? '';
    if (part !== other) {
      return part < other ? -1 : 1;
    }
  }
  return 0;
}

/** A position as a cursor: `[side, ...key]` as JSON, in unpadded base64url. */
function encodeCursor(position: Position): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(JSON.stringify([position.side, ...position.key]))) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/[=]+$/, '');
}

/** The position a cursor names, or undefined for text `encodeCursor` did not write. */
function decodeCursor(cursor: string): Position | undefined {
  if (cursor.length > MAX_CURSOR_LENGTH || !CURSOR_TEXT.test(cursor)) {
    return undefined;
  }
  try {
    const base64 = cursor.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (
      Array.isArray(parsed) &&
      parsed.length > 1 &&
      (parsed[0] === 'after' || parsed[0] === 'before') &&
      parsed.every((part) => typeof part === 'string')
    ) {
      return { side: parsed[0], key: parsed.slice(1) };
    }
  } catch {
    // Not base64, not UTF-8 text or not JSON: not a cursor.
  }
  return undefined;
}

/**
 * The key of the item a cursor of `cutPage` sits beside, or undefined for text that is not such a cursor: a
 * service checks with it that a cursor belongs to the list it is asked for before it reads that list.
 */
export function cursorKey(cursor: string): readonly string[] | undefined {
  return decodeCursor(cursor)?.key;
}

/**
 * One page of a list a service holds whole, such as one a provider answers complete. A cursor is a
 * place between two items, right after one page's last item (`nextCursor`) or right before its first
 * (`previousCursor`), never an offset: it keeps its meaning while items come and go, the one it names
 * included. `forward` takes the items after the place and `backward` the ones before it, and both answer in
 * the list's `ordering`; without a cursor, `forward` starts at the first item and `backward` at the last. A cursor
 * is null exactly when there is no such page. Undefined when the query's cursor is not one this list made,
 * including a key of another length, for the service to refuse as it does.
 */
export function cutPage<Item>(
  items: readonly Item[],
  ordering: PageOrder<Item>,
  query: PageQuery
): Page<Item> | undefined {
  const sign = ordering.order === 'desc' ? -1 : 1;
  const sorted = items
    .map((item) => ({ item, key: ordering.key(item) }))
    .toSorted((left, right) => sign * compareKeys(left.key, right.key));
  const forward = query.direction === 'forward';
  let at = forward ? 0 : sorted.length;
  if (query.cursor !== undefined) {
    const position = decodeCursor(query.cursor);
    const listedKey = sorted[0]?.key;
    // A key with another number of parts was made by another list.
    if (!position || (listedKey !== undefined && listedKey.length !== position.key.length)) {
      return undefined;
    }
    // The index of the first item after the place.
    const after = sorted.findIndex(({ key }) => {
      const comparison = sign * compareKeys(key, position.key);
      return position.side === 'after' ? comparison > 0 : comparison >= 0;
    });
    at = after === -1 ? sorted.length : after;
  }
  const start = forward ? at : Math.max(0, at - query.limit);
  const end = forward ? Math.min(sorted.length, at + query.limit) : at;
  const page = sorted.slice(start, end);
  /**
   * The cursor beside an edge item; for an empty page, the cursor it was asked from, which still divides the
   * items before it from the items after it.
   */
  const cursorBeside = (entry: { key: readonly string[] } | undefined, side: Position['side']) =>
    entry ? encodeCursor({ side, key: entry.key }) : (query.cursor ?? null);
  const hasNextPage = end < sorted.length;
  const hasPreviousPage = start > 0;
  return {
    object: 'list',
    data: page.map(({ item }) => item),
    pageInfo: {
      hasNextPage,
      hasPreviousPage,
      nextCursor: hasNextPage ? cursorBeside(page.at(-1), 'after') : null,
      previousCursor: hasPreviousPage ? cursorBeside(page.at(0), 'before') : null,
    },
  };
}
