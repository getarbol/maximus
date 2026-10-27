/**
 * Pricing in Node, through the API the Worker serves: a quote, an item the catalog does not list, and a
 * refused input; the public OpenAPI document, which leaves the internal route out; and the RPC document its
 * callers bind to, which lists the route and is current with it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createRpcOpenApi } from '@arbol-ai/maximus';
import { expect, it } from 'vite-plus/test';

import { app } from '#maximus/app';
import { handler } from '#maximus/http';

/** The development token `vp test` accepts from localhost, as a developer holding every scope. */
const token = 'test-development-token-for-local-tests';
const env = { DEVELOPMENT_TOKEN: token } as Env;

/** Asks for a quote of the items. */
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

it('prices each line and the order', async () => {
  expect(
    await requestQuote([
      { sku: 'TEA-001', quantity: 2 },
      { sku: 'MUG-001', quantity: 1 },
    ])
  ).toMatchObject({
    status: 200,
    body: { data: { currency: 'USD', totalCents: 2100, lines: [{ totalCents: 900 }, { totalCents: 1200 }] } },
  });
});

it('names the position of an item the catalog does not list, never its value', async () => {
  expect(
    await requestQuote([
      { sku: 'TEA-001', quantity: 1 },
      { sku: 'XYZ-999', quantity: 1 },
    ])
  ).toMatchObject({
    status: 422,
    body: { error: { code: 'UNKNOWN_SKU', data: { index: 1 } } },
  });
  expect((await requestQuote([])).status).toBe(400);
  expect((await requestQuote([{ sku: 'tea', quantity: 0 }])).status).toBe(400);
});

it('keeps the internal quote route out of the public OpenAPI document', async () => {
  const response = await handler(new Request('http://localhost/api/openapi.json'), env);
  const document = (await response.json()) as { paths: Record<string, unknown> };
  expect(Object.keys(document.paths)).not.toContain('/v1/quotes');
});

it('publishes the RPC document its callers bind to, current with its routes', () => {
  const published: unknown = JSON.parse(
    readFileSync(join(import.meta.dirname, '../openapi.rpc.json'), 'utf-8')
  );
  expect(published).toStrictEqual(createRpcOpenApi(app));
  expect(published).toMatchObject({
    paths: { '/rpc/quoteItems': { post: { 'x-rpc-callers': ['example-orders'] } } },
  });
});
