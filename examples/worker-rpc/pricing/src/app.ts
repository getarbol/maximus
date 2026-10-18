/**
 * The pricing application: one operation served only over Worker RPC, to the orders Worker.
 */
import { defineErrors, err, maximus, ok, t } from '@arbol-ai/maximus';

import { ItemsSchema, QuoteSchema } from './schemas';

/** A deliberately small catalog: price in cents per unit. */
const CATALOG: Readonly<Record<string, number>> = { 'TEA-001': 450, 'TEA-002': 600, 'MUG-001': 1200 };

/** The standard failures plus the pricing service's own. */
export const errors = defineErrors({
  unknownSku: {
    code: 'UNKNOWN_SKU',
    status: 422,
    message: 'An item is not in the catalog.',
    // The position of the refused item, never the submitted value.
    dataSchema: t.Object({ index: t.Integer({ minimum: 0 }) }, { additionalProperties: false }),
  },
});

/** The pricing application: quotes catalog items for the orders Worker, over RPC only. */
export const app = maximus<Record<string, never>>({
  name: 'example-pricing',
  namespace: 'pricing',
  title: 'Pricing',
  version: '1.0.0',
  origin: 'https://pricing.example.com',
  tokens: { issuer: 'https://auth.example.com/', audience: 'https://pricing.example.com' },
  errors,
  // The deployments allowed to call this service over native RPC, named by their binding props.
  rpc: { callers: ['orders'] },
})
  .operation(
    'quoteItems',
    {
      scope: 'pricing:quotes:read',
      effect: 'read',
      title: 'Quote items',
      description: 'Price a list of catalog items for the calling organization.',
      input: t.Object({ items: ItemsSchema }, { additionalProperties: false }),
      output: QuoteSchema,
      // Native RPC only: no HTTP route and no MCP tool.
      rpc: true,
    },
    async (_context, input) => {
      const lines = [];
      for (const [index, item] of input.items.entries()) {
        const unitCents = CATALOG[item.sku];
        if (unitCents === undefined) {
          return err(errors.unknownSku.create({ index }));
        }
        lines.push({ ...item, unitCents, totalCents: unitCents * item.quantity });
      }
      const totalCents = lines.reduce((sum, line) => sum + line.totalCents, 0);
      return ok({ currency: 'USD' as const, lines, totalCents });
    }
  )
  .build();
