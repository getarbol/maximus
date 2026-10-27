/**
 * The catalog pricing quotes from: a deliberately small one, in US cents per unit.
 */
import type { Items, Quote } from './contract.ts';

/** The price of one unit of each SKU, in US cents. */
const CATALOG: Readonly<Record<string, number>> = { 'TEA-001': 450, 'TEA-002': 600, 'MUG-001': 1200 };

/** The quote of the items, or the position of the first one the catalog does not list. */
export function quote(items: Items): { quote: Quote } | { unknown: number } {
  const lines = [];
  for (const [index, item] of items.entries()) {
    const unitCents = CATALOG[item.sku];
    if (unitCents === undefined) {
      return { unknown: index };
    }
    lines.push({ ...item, unitCents, totalCents: unitCents * item.quantity });
  }
  return {
    quote: { currency: 'USD', lines, totalCents: lines.reduce((sum, line) => sum + line.totalCents, 0) },
  };
}
