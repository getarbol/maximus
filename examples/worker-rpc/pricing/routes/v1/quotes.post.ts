import { defineHandler } from '@arbol-ai/maximus';

import { priceItems } from '#src/catalog.ts';
import { ItemsSchema, QuoteSchema } from '#src/contract.ts';

/**
 * POST /api/v1/quotes, and the RPC method quoteItems the orders Worker calls. Internal: the public OpenAPI
 * document leaves it out, though its scope still admits a caller over HTTP.
 */
export default defineHandler(
  ({ input, fail }) => {
    const priced = priceItems(input.items);
    if (!priced.ok) {
      return fail('UNKNOWN_SKU', { index: priced.unknownIndex });
    }
    return priced.quote;
  },
  {
    description: 'Price a list of catalog items for the calling organization.',
    effect: 'read',
    // The RPC method's name, as the contract its callers import declares it.
    operationId: 'quoteItems',
    input: { items: ItemsSchema },
    output: QuoteSchema,
    failures: ['UNKNOWN_SKU'],
    rpc: true,
    visibility: 'internal',
  }
);
