import { defineHandler, t } from '@arbol-ai/maximus';
import type { Result } from '@arbol-ai/maximus';

import type { Quote, QuoteItemsFailure } from '#maximus/services/pricing';
import { OrderItemsSchema } from '#src/items.ts';

/**
 * POST /api/v1/quotes: what an order of these items would cost, as the pricing Worker prices them. Nothing
 * is reserved or charged.
 */
export default defineHandler(
  async ({ env, principal, input, fail }) => {
    let priced: Result<Quote, QuoteItemsFailure>;
    try {
      // The caller's verified principal travels as it is; pricing checks it and the items again.
      priced = await env.PRICING.quoteItems(principal, input);
    } catch {
      return fail('UPSTREAM_UNAVAILABLE');
    }
    if (priced.ok) {
      return { currency: priced.value.currency, totalCents: priced.value.totalCents };
    }
    // Name the item a caller can fix, keep a failure pricing may recover from retryable, and answer the rest,
    // a refusal included, as this service's own fault.
    const failure = priced.error;
    if (failure.code === 'UNKNOWN_SKU') {
      return fail('UNKNOWN_ITEM', { index: failure.data.index });
    }
    if (failure.retryable) {
      return fail('UPSTREAM_UNAVAILABLE');
    }
    return fail('INTERNAL_ERROR');
  },
  {
    description: 'Price the items of a prospective order. Nothing is reserved or charged.',
    effect: 'read',
    input: { items: OrderItemsSchema },
    output: { currency: t.Literal('USD'), totalCents: t.Integer({ minimum: 0 }) },
    failures: ['UNKNOWN_ITEM'],
  }
);
