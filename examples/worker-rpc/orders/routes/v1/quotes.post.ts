import { defineHandler, t } from '@arbol-ai/maximus';
import { checkSchema } from '@arbol-ai/maximus/schemas';
import { ItemsSchema, UnknownSkuSchema } from '@maximus-examples/pricing/contract';

/**
 * POST /api/v1/quotes: what an order of these items would cost, as the pricing Worker prices them. Nothing
 * is reserved or charged.
 */
export default defineHandler(
  async ({ env, principal, input, fail }) => {
    let priced;
    try {
      // The caller's verified principal travels as it is; pricing checks it and the items again.
      priced = await env.PRICING.quoteItems(principal, input);
    } catch {
      return fail('UPSTREAM_UNAVAILABLE');
    }
    if (priced.ok) {
      return { currency: priced.value.currency, totalCents: priced.value.totalCents };
    }
    // Name the item a caller can fix, keep a failure pricing may recover from retryable, and answer anything
    // else, a refusal included, as this service's own fault.
    const unknown =
      priced.error.code === 'UNKNOWN_SKU' ? checkSchema(UnknownSkuSchema, priced.error.data) : undefined;
    if (unknown?.success) {
      return fail('UNKNOWN_ITEM', unknown.data);
    }
    return fail(priced.error.retryable ? 'UPSTREAM_UNAVAILABLE' : 'INTERNAL_ERROR');
  },
  {
    description: 'Price the items of a prospective order. Nothing is reserved or charged.',
    effect: 'read',
    input: { items: ItemsSchema },
    output: { currency: t.Literal('USD'), totalCents: t.Integer({ minimum: 0 }) },
    failures: ['UNKNOWN_ITEM'],
  }
);
