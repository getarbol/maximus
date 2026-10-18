# Two Workers over native RPC

`orders` is an HTTP service. To quote an order it calls `pricing`, which exposes its only operation
as a native RPC method, through a Service Binding.

| File                           | Contains                                                                               |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `pricing/src/schemas.ts`       | The pricing contract, shared with callers.                                             |
| `pricing/src/app.ts`           | `quoteItems`, an RPC-only operation, and the allowed callers (`rpc.callers`).          |
| `pricing/src/index.ts`         | Exports `PricingService`, the named entrypoint.                                        |
| `pricing/cloudflare.config.ts` | The pricing Worker, which declares `PricingService` and which orders binds to.         |
| `orders/src/env.ts`            | Types the binding as `Service<typeof PricingService>`.                                 |
| `orders/src/app.ts`            | `quoteOrder`, which forwards its verified principal and translates pricing's failures. |
| `orders/cloudflare.config.ts`  | The Service Binding, with props `{ caller: 'orders' }`.                                |
| `orders/vite.config.ts`        | Runs pricing beside orders under `cf dev`.                                             |

## Run it

```sh
echo "DEVELOPMENT_TOKEN=$(openssl rand -hex 32)" > orders/.dev.vars
cd orders && bun run dev        # cf dev, on http://localhost:5173
```

Orders receives HTTP; pricing runs beside it as an auxiliary Worker and answers its binding. Each one
builds and deploys from its own directory (`bun run build`, then `cf deploy --prebuilt --mode
production`), pricing first.

## Try it

```sh
TOKEN=$(sed 's/^DEVELOPMENT_TOKEN=//' orders/.dev.vars)

curl -s -X POST http://localhost:5173/v1/quotes \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"items":[{"sku":"TEA-001","quantity":2},{"sku":"MUG-001","quantity":1}]}'
# {"success":true,"data":{"totalCents":2100,"currency":"USD"},...}

curl -s -X POST http://localhost:5173/v1/quotes \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"items":[{"sku":"XYZ-999","quantity":1}]}'
# 422 UNKNOWN_ITEM with data { "index": 0 }
```

## What to notice

- Pricing checks the binding's props, the principal's shape, the input and its own output on every
  call. It does not check scopes: ordinary RPC trusts the calling deployment.
- Orders validates the same item schema before calling, so an invalid item is refused by orders
  itself.
- A failure from pricing belongs to pricing's catalog; orders translates it into its own.

See the [Worker RPC guide](../../docs/guides/worker-rpc.md).
