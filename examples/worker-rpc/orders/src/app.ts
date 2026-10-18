/**
 * The orders application: an HTTP operation that prices an order by calling the pricing Worker over RPC
 * with its caller's principal.
 */
import { defineErrors, err, maximus, ok, standardErrors, t } from '@arbol-ai/maximus';

import { ItemsSchema } from '../../pricing/src/schemas';
import type { Env } from './env';
import { tokens } from './tokens';

/** The standard failures plus the orders service's own. */
const errors = defineErrors({
  unknownItem: {
    code: 'UNKNOWN_ITEM',
    status: 422,
    message: 'An item is not in the catalog.',
    dataSchema: t.Object({ index: t.Integer({ minimum: 0 }) }, { additionalProperties: false }),
  },
});

/** The orders application: quotes an order over HTTP by asking the pricing Worker. */
export const app = maximus<Env>({
  name: 'example-orders',
  namespace: 'orders',
  title: 'Orders',
  version: '1.0.0',
  origin: 'https://orders.example.com',
  tokens,
  errors,
  rpc: { callers: [] },
})
  .operation(
    'quoteOrder',
    {
      scope: 'orders:quotes:write',
      effect: 'read',
      title: 'Quote an order',
      description: 'Price the items of a prospective order. Nothing is reserved or charged.',
      input: t.Object({ items: ItemsSchema }, { additionalProperties: false }),
      output: t.Object(
        { totalCents: t.Integer({ minimum: 0 }), currency: t.Literal('USD') },
        { additionalProperties: false }
      ),
      // A read that takes a body: POST, not GET.
      http: { method: 'POST', path: '/v1/quotes' },
    },
    async ({ env, principal }, input) => {
      let quote;
      try {
        // The verified principal travels unchanged; pricing validates it and the input again.
        quote = await env.PRICING.quoteItems(principal, { items: input.items });
      } catch {
        return err(standardErrors.upstreamUnavailable.create());
      }
      if (quote.ok) {
        return ok({ totalCents: quote.value.totalCents, currency: quote.value.currency });
      }
      // Pricing's failures are not in this catalog: translate the one a caller can act on, keep a
      // retryable upstream failure retryable, and treat anything else as this service's own fault.
      const { error } = quote;
      if (error.code === 'UNKNOWN_SKU' && 'index' in error.data && typeof error.data.index === 'number') {
        return err(errors.unknownItem.create({ index: error.data.index }));
      }
      return err(
        error.retryable ? standardErrors.upstreamUnavailable.create() : standardErrors.internal.create()
      );
    }
  )
  .build();
