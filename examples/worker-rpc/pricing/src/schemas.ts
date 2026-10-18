/**
 * The pricing contract, shared by both Workers. The orders Worker imports these schemas so it refuses what
 * pricing would refuse, instead of learning it from a failed call.
 */
import { t } from '@arbol-ai/maximus';

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
  { additionalProperties: false }
);
