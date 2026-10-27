/**
 * Orders in Node, through the API the Worker serves, over a stand-in for the pricing binding: a quote priced
 * for the caller, an item pricing does not list, the failures pricing may or may not recover from, a pricing
 * Worker that cannot be reached, and items refused before pricing is called.
 */
import type { PricingService, Quote } from '@maximus-examples/pricing/contract';
import { beforeEach, expect, it, vi } from 'vite-plus/test';

import { handler } from '#maximus/http';

/** The development token `vp test` accepts from localhost, as a developer holding every scope. */
const token = 'test-development-token-for-local-tests';
/** The pricing binding as the tests stand it in: its one RPC method, which records each call. */
const pricing = { quoteItems: vi.fn<PricingService['quoteItems']>() };
const env = { DEVELOPMENT_TOKEN: token, PRICING: pricing } as unknown as Env;

beforeEach(() => {
  pricing.quoteItems.mockReset();
});

/** Asks orders for a quote of the items. */
async function requestQuote(items: unknown) {
  const response = await handler(
    new Request('http://localhost/api/v1/quotes', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ items }),
    }),
    env
  );
  return { status: response.status, body: (await response.json()) as { data: unknown; error: unknown } };
}

/** The items of an order every test asks a quote for. */
const items = [
  { sku: 'TEA-001', quantity: 2 },
  { sku: 'MUG-001', quantity: 1 },
];
/** What pricing answers for those items. */
const quote: Quote = {
  currency: 'USD',
  lines: [
    { sku: 'TEA-001', quantity: 2, unitCents: 450, totalCents: 900 },
    { sku: 'MUG-001', quantity: 1, unitCents: 1200, totalCents: 1200 },
  ],
  totalCents: 2100,
};

it('prices the order as the caller, through pricing, and answers its total', async () => {
  pricing.quoteItems.mockResolvedValueOnce({ ok: true, value: quote });
  expect(await requestQuote(items)).toMatchObject({
    status: 200,
    body: { data: { currency: 'USD', totalCents: 2100 } },
  });
  expect(pricing.quoteItems).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ actorId: 'local-developer', organizationId: 'local-development' }),
    { items }
  );
});

it('names the item pricing does not list in its own failure', async () => {
  pricing.quoteItems.mockResolvedValueOnce({
    ok: false,
    error: {
      code: 'UNKNOWN_SKU',
      message: 'An item is not in the catalog.',
      retryable: false,
      data: { index: 1 },
    },
  });
  expect(await requestQuote(items)).toMatchObject({
    status: 422,
    body: { error: { code: 'UNKNOWN_ITEM', data: { index: 1 } } },
  });
});

it('keeps what pricing may recover from retryable, and answers the rest as its own fault', async () => {
  const pricingFailure = (code: string, retryable: boolean, data = {}) => ({
    ok: false as const,
    error: { code, message: 'Pricing failed.', retryable, data },
  });
  pricing.quoteItems
    .mockResolvedValueOnce(pricingFailure('RATE_LIMITED', true))
    .mockRejectedValueOnce(new Error('Network connection lost.'))
    .mockResolvedValueOnce(pricingFailure('UNAUTHORIZED', false))
    .mockResolvedValueOnce(pricingFailure('UNKNOWN_SKU', false, { sku: 'XYZ-999' }));
  for (const [status, code] of [
    [503, 'UPSTREAM_UNAVAILABLE'],
    [503, 'UPSTREAM_UNAVAILABLE'],
    // Pricing refused this deployment, or broke its contract: neither is the caller's to fix.
    [500, 'INTERNAL_ERROR'],
    [500, 'INTERNAL_ERROR'],
  ] as const) {
    expect(await requestQuote(items)).toMatchObject({ status, body: { error: { code } } });
  }
});

it('refuses the items pricing would refuse without calling it', async () => {
  for (const refused of [[], [{ sku: 'tea', quantity: 1 }], [{ sku: 'TEA-001', quantity: 0 }], 'TEA-001']) {
    expect((await requestQuote(refused)).status, JSON.stringify(refused)).toBe(400);
  }
  expect(pricing.quoteItems).not.toHaveBeenCalled();
});
