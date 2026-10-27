/**
 * The items of an order, as orders' own API takes them. Pricing states the same limits for its quotes, and the
 * types of its RPC methods make the compiler hold orders to them.
 */
import { t } from '@arbol-ai/maximus';

/** One line of an order: a catalog SKU and how many units of it. */
export const OrderItemSchema = t.Object(
  {
    sku: t.String({ pattern: '^[A-Z]{3}-[0-9]{3}$' }),
    quantity: t.Integer({ minimum: 1, maximum: 1000 }),
  },
  { additionalProperties: false }
);

/** The items of one order: at least one, at most 50. */
export const OrderItemsSchema = t.Array(OrderItemSchema, { minItems: 1, maxItems: 50 });
