/**
 * The one list contract: bidirectional keyset pagination. A list takes the query fields `cursor`,
 * `direction` and `limit` and answers `{ object: 'list', data, pageInfo }`. The cursor is opaque to
 * callers; there is no page number, page size, offset or implicit total.
 *
 * `PageInfo` and each `Page` are named schemas, so an OpenAPI document carries them once as
 * `#/components/schemas/<name>` and every SDK generated from it shares their types.
 */
import { Type } from '@sinclair/typebox';
import type { Static, TArray, TLiteral, TObject, TProperties, TSchema } from '@sinclair/typebox';

import { defaultSchema } from './input-schemas.ts';

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
      pageInfo: {
        ...PageInfoSchema,
        description: 'Opaque navigation cursors for this page’s stable keyset order.',
      },
    },
    { $id: options.$id, additionalProperties: false }
  );
}
