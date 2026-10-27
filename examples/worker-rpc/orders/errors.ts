/**
 * The orders service's own failures. Pricing's failures belong to pricing's catalog; the quote route
 * translates the one a caller can act on into this one.
 */
import { defineErrors, t } from '@arbol-ai/maximus';

export default defineErrors({
  unknownItem: {
    code: 'UNKNOWN_ITEM',
    status: 422,
    message: 'An item is not in the catalog.',
    dataSchema: t.Object({ index: t.Integer({ minimum: 0 }) }, { additionalProperties: false }),
  },
});
