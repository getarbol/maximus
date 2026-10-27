/**
 * What pricing shares with the Workers that call it: the schemas of a quote, the data of its one failure and
 * the RPC entrypoint they bind. It imports no project module, so a caller depends on this file alone, never
 * on pricing's routes or the registry they are typed by.
 */
import { t } from '@arbol-ai/maximus';
import type { Failure, Principal, Result, Static } from '@arbol-ai/maximus';
import type { WorkerEntrypoint } from 'cloudflare:workers';

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

/**
 * Pricing's RPC entrypoint, the `Service` export a Service Binding names: one method per route that declares
 * `rpc`, called with the caller's verified principal. Pricing's tests prove its routes serve exactly these.
 */
export interface PricingService extends WorkerEntrypoint {
  /** The quote route over RPC: the quote of the items, or `UNKNOWN_SKU` naming the first unknown one. */
  quoteItems: (principal: Principal, input: { items: Items }) => Promise<Result<Quote, Failure>>;
}
