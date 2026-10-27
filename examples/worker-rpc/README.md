# Two Workers over native RPC

`orders` quotes orders over HTTP. To price one, it calls `pricing` over native RPC through a Service Binding,
as the caller who asked. Pricing admits only the deployments its `rpc.callers` names, by the props their
binding carries.

```text
pricing/vite.config.ts             rpc: { callers: ['orders'] }
pricing/routes/v1/quotes.post.ts   The quote route; rpc: true makes it the RPC method quoteItems too
pricing/src/contract.ts            What callers import: the schemas, UNKNOWN_SKU's data, the entrypoint's type
pricing/src/catalog.ts             The prices
pricing/errors.ts                  UNKNOWN_SKU
pricing/tests/quotes.test.ts       The route in Node, and the proof that it serves the contract
orders/vite.config.ts              The Service Binding PRICING, with props { caller: 'orders' }
orders/src/pricing.ts              Types env.PRICING with pricing's contract
orders/routes/v1/quotes.post.ts    Forwards the verified principal and answers in its own catalog
orders/errors.ts                   UNKNOWN_ITEM
orders/tests/quotes.test.ts        Orders in Node, over a stand-in for the binding
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

## What to notice

- Pricing checks the binding's props, the principal's shape, the input and its own output on every call.
  It does not check scopes: RPC trusts the calling deployment, which admitted the caller.
- Orders never imports pricing's routes, which pricing's registry types. It imports `src/contract.ts`,
  which imports no project module, and pricing's type test fails the moment its routes and the contract
  differ.
- Orders refuses the items pricing would refuse before calling it, with the same schema.
- A failure from pricing belongs to pricing's catalog: orders names the item a caller can fix, keeps a
  failure pricing may recover from retryable, and answers the rest as its own.
