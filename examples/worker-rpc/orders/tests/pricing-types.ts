/**
 * Compile-only proof that orders calls pricing as pricing's RPC document types it: the binding takes pricing's
 * input and answers its quote or one of the failures its document names, each narrowed by its code.
 */
import type { Principal } from '@arbol-ai/maximus';

declare const env: Env;
declare const principal: Principal;

const priced = await env.PRICING.quoteItems(principal, { items: [{ sku: 'TEA-001', quantity: 1 }] });
if (priced.ok) {
  const totalCents: number = priced.value.totalCents;
  void totalCents;
} else if (priced.error.code === 'UNKNOWN_SKU') {
  // The data UNKNOWN_SKU declares, typed without a check of its own.
  const index: number = priced.error.data.index;
  void index;
} else {
  // @ts-expect-error quoteItems never answers a failure its document does not name.
  void (priced.error.code === 'INVALID_CURSOR');
}
// @ts-expect-error quoteItems takes the items of an order, not a list of SKUs.
void env.PRICING.quoteItems(principal, { skus: ['TEA-001'] });
// @ts-expect-error pricing serves no other method over native RPC.
void env.PRICING.listPrices;
