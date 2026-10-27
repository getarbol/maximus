/**
 * The schemas of a quote: the items it prices, the quote itself and the data of its one failure. The Workers
 * that call pricing never import them: they bind to the RPC document pricing publishes, openapi.rpc.json,
 * which `maximus openapi` writes from the routes that use these schemas.
 */
import { t } from '@arbol-ai/maximus';
import type { Static } from '@arbol-ai/maximus';

/** One line of an order: a catalog SKU and how many units of it. */
export const ItemSchema = t.Object(
  {
    sku: t.String({ pattern: '^[A-Z]{3}-[0-9]{3}$' }),
    quantity: t.Integer({ minimum: 1, maximum: 1000 }),
  },
  { additionalProperties: false }
);

/** The items of one quote: at least one, at most 50. */
export const ItemsSchema = t.Array(ItemSchema, { minItems: 1, maxItems: 50 });
/** The items of one quote. */
export type Items = Static<typeof ItemsSchema>;

/** A quote: each line's unit and total price, and the order's total, in US cents. */
export const QuoteSchema = t.Object(
  {
    currency: t.Literal('USD'),
    lines: t.Array(
      t.Object(
        { sku: t.String(), quantity: t.Integer(), unitCents: t.Integer(), totalCents: t.Integer() },
        { additionalProperties: false }
      )
    ),
    totalCents: t.Integer({ minimum: 0 }),
  },
  { $id: 'Quote', additionalProperties: false }
);
/** A quote. */
export type Quote = Static<typeof QuoteSchema>;

/** The data of `UNKNOWN_SKU`: the position of the first item the catalog does not list, never its value. */
export const UnknownSkuSchema = t.Object(
  { index: t.Integer({ minimum: 0 }) },
  { additionalProperties: false }
);
