# Two Workers over native RPC

`orders` quotes orders over HTTP. To price one, it calls `pricing` over native RPC through a Service Binding,
as the caller who asked. Pricing admits only the deployments its `rpc.callers` names, by the props their
binding carries.

```text
pricing/vite.config.ts             rpc: { callers: ['example-orders'] }
pricing/routes/v1/quotes.post.ts   The quote route; rpc: true makes it the RPC method quoteItems too
pricing/src/quotes.ts              The schemas of a quote and of UNKNOWN_SKU's data
pricing/src/catalog.ts             The prices
pricing/errors.ts                  UNKNOWN_SKU
pricing/openapi.rpc.json           The RPC document callers bind to, written by maximus openapi
pricing/tests/quotes.test.ts       The route in Node, and the proof that openapi.rpc.json is current
orders/vite.config.ts              services: { PRICING: { worker, openapi: '../pricing/openapi.rpc.json' } }
orders/routes/v1/quotes.post.ts    Forwards the verified principal and answers in its own catalog
orders/src/items.ts                The items of an order, as orders' API takes them
orders/errors.ts                   UNKNOWN_ITEM
orders/tests/quotes.test.ts        Orders in Node, over a stand-in for the binding
orders/tests/pricing-types.ts      Compile-only proof that calls follow pricing's document
```

## Run it

Pricing first, so orders finds it in the local dev registry; each in its own terminal.

```sh
cd examples/worker-rpc/pricing
bun run dev                        # http://localhost:5174

cd examples/worker-rpc/orders
echo "DEVELOPMENT_TOKEN=$(openssl rand -hex 32)" > .dev.vars
bun run dev                        # http://localhost:5173
```

```sh
TOKEN=$(cut -d= -f2 orders/.dev.vars)
curl -s -X POST http://localhost:5173/api/v1/quotes \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"items":[{"sku":"TEA-001","quantity":2},{"sku":"MUG-001","quantity":1}]}'
# {"success":true,"data":{"currency":"USD","totalCents":2100},…}

curl -s -X POST http://localhost:5173/api/v1/quotes \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"items":[{"sku":"TEA-001","quantity":1},{"sku":"XYZ-999","quantity":1}]}'
# 422 UNKNOWN_ITEM, with data {"index":1}
```

## Deploy it

Pricing first: orders' binding names it.

```sh
export WORKERS_SUBDOMAIN=<your workers.dev subdomain>
(cd pricing && bun run build && bunx cf deploy --prebuilt --mode production)
(cd orders && bun run build && bunx cf deploy --prebuilt --mode production)
```

## Change pricing

Pricing's routes are the source of its RPC document. After a change, write the document again and commit
it; orders' type check then holds orders to it:

```sh
cd examples/worker-rpc/pricing && bunx maximus openapi
# openapi.json was written: 0 operations. openapi.rpc.json was written: 1 operation.
cd ../orders && bun run typecheck
```

`bun run openapi` in pricing, which CI runs, fails while the committed document differs from the routes.

## What to notice

- Pricing checks the binding's props, the principal's shape, the input and its own output on every call.
  It does not check scopes: RPC trusts the calling deployment, which admitted the caller.
- Orders imports nothing of pricing's project. `maximus prepare` types `env.PRICING` from pricing's RPC
  document, in `.maximus/services/pricing.ts`, and orders imports the types it names, `Quote` and
  `QuoteItemsFailure`, from `#maximus/services/pricing`.
- Orders refuses the items pricing would refuse before calling it, with its own schema; the compiler holds it
  to pricing's input type where orders passes it.
- A failure from pricing belongs to pricing's catalog: orders names the item a caller can fix, keeps a
  failure pricing may recover from retryable, and answers the rest as its own.
