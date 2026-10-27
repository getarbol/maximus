/**
 * The catalog pricing quotes from: a deliberately small one, in US cents per unit.
 */
import type { Items, Quote } from './quotes.ts';

/** The price of one unit of each SKU, in US cents. */
const UNIT_PRICE_CENTS: Readonly<Record<string, number>> = {
  'TEA-001': 450,
  'TEA-002': 600,
  'MUG-001': 1200,
};

/** The items' quote, or the position of the first item the catalog does not list. */
export type PricedItems = { ok: true; quote: Quote } | { ok: false; unknownIndex: number };

/** Prices the items: their quote, or the position of the first item the catalog does not list. */
export function priceItems(items: Items): PricedItems {
  const lines: Quote['lines'] = [];
  for (const [index, item] of items.entries()) {
    const unitCents = UNIT_PRICE_CENTS[item.sku];
    if (unitCents === undefined) {
      return { ok: false, unknownIndex: index };
    }
    lines.push({ ...item, unitCents, totalCents: unitCents * item.quantity });
  }
  const totalCents = lines.reduce((sum, line) => sum + line.totalCents, 0);
  return { ok: true, quote: { currency: 'USD', lines, totalCents } };
}
