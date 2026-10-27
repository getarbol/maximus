/**
 * The two Workers of the RPC example running side by side: orders prices an order by calling pricing over
 * native RPC, and answers pricing's refusal in its own catalog.
 */
import { describe, expect, it } from 'vite-plus/test';

import { call, data, required, service } from './services.ts';
import { publicSurface } from './surface.ts';

publicSurface('pricing', { method: 'POST', path: '/v1/quotes', published: false });
publicSurface('orders', { method: 'POST', path: '/v1/quotes' });

describe.runIf(service('orders')?.token && service('pricing'))('orders and pricing: signed in', () => {
  it('quotes an order through pricing, and names the item pricing does not list', async () => {
    const orders = required('orders');
    const items = [
      { sku: 'TEA-001', quantity: 2 },
      { sku: 'MUG-001', quantity: 1 },
    ];
    expect(await data(call(orders, '/api/v1/quotes', { method: 'POST', json: { items } }))).toEqual({
      currency: 'USD',
      totalCents: 2100,
    });
    const refused = await call(orders, '/api/v1/quotes', {
      method: 'POST',
      json: { items: [...items, { sku: 'XYZ-999', quantity: 1 }] },
    });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ error: { code: 'UNKNOWN_ITEM', data: { index: 2 } } });
  });
});
