/**
 * The pricing service's own failures. A refused item is named by its position, never by its value.
 */
import { defineErrors } from '@arbol-ai/maximus';

import { UnknownSkuSchema } from '#src/quotes.ts';

export default defineErrors({
  unknownSku: {
    code: 'UNKNOWN_SKU',
    status: 422,
    message: 'An item is not in the catalog.',
    dataSchema: UnknownSkuSchema,
  },
});
