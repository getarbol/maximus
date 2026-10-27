import { defineHandler, t } from '@arbol-ai/maximus';
import type { Failure, Result } from '@arbol-ai/maximus';
import { checkSchema } from '@arbol-ai/maximus/schemas';
import { ItemsSchema, UnknownSkuSchema } from '@maximus-examples/pricing/contract';
import type { Quote } from '@maximus-examples/pricing/contract';

/**
 * POST /api/v1/quotes: what an order of these items would cost, as the pricing Worker prices them. Nothing
 * is reserved or charged.
 */
export default defineHandler(
  async ({ env, principal, input, fail }) => {
    let priced: Result<Quote, Failure>;
    try {
      // The caller's verified principal travels as it is; pricing checks it and the items again.
      priced = await env.PRICING.quoteItems(principal, input);
    } catch {
      return fail('UPSTREAM_UNAVAILABLE');
    }
    if (priced.ok) {
      const quote = priced.value;
      return { currency: quote.currency, totalCents: quote.totalCents };
    }
    // Name the item a caller can fix, keep a failure pricing may recover from retryable, and answer anything
    // else, a refusal included, as this service's own fault.
    const failure = priced.error;
    if (failure.code === 'UNKNOWN_SKU') {
      const unknownSku = checkSchema(UnknownSkuSchema, failure.data);
      if (unknownSku.success) {
        return fail('UNKNOWN_ITEM', unknownSku.data);
      }
    }
    if (failure.retryable) {
      return fail('UPSTREAM_UNAVAILABLE');
    }
    return fail('INTERNAL_ERROR');
  },
  {
    description: 'Price the items of a prospective order. Nothing is reserved or charged.',
    effect: 'read',
    input: { items: ItemsSchema },
    output: { currency: t.Literal('USD'), totalCents: t.Integer({ minimum: 0 }) },
    failures: ['UNKNOWN_ITEM'],
  }
);
