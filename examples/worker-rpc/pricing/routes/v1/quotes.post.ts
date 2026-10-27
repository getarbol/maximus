import { defineHandler } from '@arbol-ai/maximus';

import { quote } from '../../src/catalog.ts';
import { ItemsSchema, QuoteSchema } from '../../src/contract.ts';

/**
 * POST /api/v1/quotes, and the RPC method quoteItems the orders Worker calls. Internal: the public OpenAPI
 * document leaves it out, though its scope still admits a caller over HTTP.
 */
export default defineHandler(
  ({ input, fail }) => {
    const priced = quote(input.items);
    return 'quote' in priced ? priced.quote : fail('UNKNOWN_SKU', { index: priced.unknown });
  },
  {
    description: 'Price a list of catalog items for the calling organization.',
    effect: 'read',
    operationId: 'quoteItems',
    input: { items: ItemsSchema },
    output: QuoteSchema,
    failures: ['UNKNOWN_SKU'],
    rpc: true,
    visibility: 'internal',
  }
);
