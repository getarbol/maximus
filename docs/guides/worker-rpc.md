# Worker RPC

A route can also be a method that other Workers of your Cloudflare account call through a
[Service Binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/),
with no HTTP request, token or JSON body in between. This guide follows
[`examples/worker-rpc`](../../examples/worker-rpc), where the Worker `orders` prices an order by calling
the Worker `pricing`: how the owner serves a route over RPC, publishes its contract and keeps it in step,
and how a caller binds it, types it and calls it.

## Serve a route over RPC

The owner names the Workers allowed to call it in `maximus()`, by the caller name their bindings carry:

```ts
// pricing/vite.config.ts
import { maximus } from '@arbol-ai/vite-plugin';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [
    maximus({
      name: 'example-pricing',
      namespace: 'pricing',
      origin: 'https://example-pricing.example.workers.dev',
      tokens: { issuer: 'https://auth.example.com/' },
      compatibilityDate: '2026-10-26',
      rpc: { callers: ['orders'] },
    }),
  ],
});
```

and each route it serves over RPC says so in its contract:

```ts
// pricing/routes/v1/quotes.post.ts
import { defineHandler } from '@arbol-ai/maximus';

import { quote } from '../../src/catalog.ts';
import { ItemsSchema, QuoteSchema } from '../../src/contract.ts';

/** POST /api/v1/quotes, and the RPC method quoteItems the orders Worker calls. */
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
```

`rpc: true` admits every caller of `rpc.callers`; `rpc: { callers: ['orders'] }` admits only those it
lists, each of which `rpc.callers` must name, or the Worker does not start:
`Operation "<name>": RPC callers must be allowed by the application.` A tool of `mcp/tools/` takes `rpc`
too.

The method's name is the operation's: the method and path in camelCase, `postV1Quotes`, unless
`operationId` names it, as `quoteItems` does here. The generated Worker exports one entrypoint, `Service`,
with one method per route or tool that declares `rpc`. A route that declares no `rpc` is no method, and
`visibility: 'internal'` keeps this one out of the public OpenAPI document while it still answers over
HTTP to tokens that hold its scope. Routes with byte bodies or attachments are HTTP-only:
`Operation "<name>": byte bodies and attachments are HTTP-only.`

Each method takes the caller's principal and the input, and answers a `Result`:
`(principal, input) => Promise<Result<Output, Failure>>`. The input is what the route's schema accepts on
the wire: a field with a default may be left out, and a field an input codec transforms is sent as its
source. The answer is `{ ok: true, value }` with the route's output, or `{ ok: false, error }` with a
failure of the owner's catalog.

## What the owner checks

Before any of its code runs, the owner checks each call:

1. The binding's props are exactly `{ caller }`, and the route admits that caller. Anything else answers
   `UNAUTHORIZED`.
2. The principal matches the principal's schema exactly: an `actorId`, an `actorKind` of `user` or
   `service`, an `organizationId` and a UUID `requestId`, and nothing else. Anything else answers
   `UNAUTHORIZED`.
3. The call then runs as on every transport: the route's `actorKinds`, input decoding (`INVALID_INPUT`),
   `context.ts`, operation middleware, the handler and the check of its answer.

A call over RPC carries no token, so no scope is checked and no rate limit applies: the owner trusts the
calling deployment, which its props identify and only your account's configuration can set, and the
principal it forwards. Handlers receive no `authority`, so a route with
[conditional scopes](authentication-and-scopes.md#scopes-the-handler-checks) refuses every RPC call with
`FORBIDDEN`. Anyone who can deploy a Worker with a binding that names an admitted caller can call the
owner as any principal: name callers narrowly, and give each route the shortest `callers` list it needs.

When the owner must verify the original caller's token and scopes itself, call its HTTP API instead, with
the caller's own token, `authority.token` (see
[Context and middleware](middleware-and-context.md#what-a-handler-receives)).

## Publish a contract

The caller never imports the owner's routes: their types depend on the owner's generated registry. The
owner publishes a contract module instead, which imports no module of its project: the schemas a caller
shares, the data of the failures it may need to read, and the type of the entrypoint.

```ts
// pricing/src/contract.ts
import { t } from '@arbol-ai/maximus';
import type { Failure, Principal, Result, Static } from '@arbol-ai/maximus';
import type { WorkerEntrypoint } from 'cloudflare:workers';

/** One line of an order: a catalog SKU and how many units of it. */
export const ItemSchema = t.Object(
  {
    sku: t.String({ pattern: '^[A-Z]{3}-[0-9]{3}$' }),
    quantity: t.Integer({ minimum: 1, maximum: 1000 }),
  },
  { additionalProperties: false }
);

/** The items of one quote: at least one, at most 50. */
export const ItemsSchema = t.Array(ItemSchema, { minItems: 1, maxItems: 50 });
export type Items = Static<typeof ItemsSchema>;

/** A quote: each line's unit and total price, and the order's total, in US cents. */
export const QuoteSchema = t.Object(
  {
    currency: t.Literal('USD'),
    lines: t.Array(
      t.Object(
        { sku: t.String(), quantity: t.Integer(), unitCents: t.Integer(), totalCents: t.Integer() },
        { additionalProperties: false }
      )
    ),
    totalCents: t.Integer({ minimum: 0 }),
  },
  { $id: 'Quote', additionalProperties: false }
);
export type Quote = Static<typeof QuoteSchema>;

/** The data of `UNKNOWN_SKU`: the position of the first item the catalog does not list. */
export const UnknownSkuSchema = t.Object(
  { index: t.Integer({ minimum: 0 }) },
  { additionalProperties: false }
);

/** Pricing's `Service` entrypoint: one method per route that declares `rpc`. */
export interface PricingService extends WorkerEntrypoint {
  quoteItems: (principal: Principal, input: { items: Items }) => Promise<Result<Quote, Failure>>;
}
```

Callers import it as a package export of the owner, `"./contract": "./src/contract.ts"` in its
`package.json`, or from a package the two share.

### Keep the contract in step

The contract repeats what the routes declare, so the owner proves the two agree with a type test.
`RpcMethods<typeof app.operations>`, from `@arbol-ai/maximus/workers`, is the type of the methods the
routes serve:

```ts
// pricing/tests/quotes.test.ts
import type { RpcMethods } from '@arbol-ai/maximus/workers';
import type { WorkerEntrypoint } from 'cloudflare:workers';
import { expectTypeOf, it } from 'vite-plus/test';

import type { app } from '#maximus/app';

import type { PricingService } from '../src/contract.ts';

it('serves over RPC exactly the methods its contract declares', () => {
  expectTypeOf<RpcMethods<typeof app.operations>>().toEqualTypeOf<
    Omit<PricingService, keyof WorkerEntrypoint>
  >();
});
```

The test fails to type-check the moment a route and the contract differ: a method added or removed, an
input or an output changed.

## Bind and call the owner

The caller declares a Service Binding to the owner's Worker, by its name, and to its `Service`
entrypoint. Its `props` name the caller:

```ts
// orders/vite.config.ts
import { maximus } from '@arbol-ai/vite-plugin';
import { bindings } from 'cf/config';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [
    maximus({
      name: 'example-orders',
      namespace: 'orders',
      origin: 'https://example-orders.example.workers.dev',
      tokens: { issuer: 'https://auth.example.com/' },
      compatibilityDate: '2026-10-26',
      env: {
        PRICING: bindings.worker({
          worker: 'example-pricing',
          exportName: 'Service',
          props: { caller: 'orders' },
        }),
      },
    }),
  ],
});
```

The props belong to the deployment, never to a request. A binding that names the owner's Worker carries
no types of its methods, so the caller types it once, with the contract, in a global `Env` declaration:

```ts
// orders/src/pricing.ts
import type { PricingService } from '@maximus-examples/pricing/contract';

declare global {
  interface Env {
    /** Pricing's `Service` entrypoint, called as `orders`. */
    PRICING: Service<PricingService>;
  }
}
```

A route of the caller then calls the method with the principal its own call was verified with, and
answers in its own catalog:

```ts
// orders/routes/v1/quotes.post.ts
import { defineHandler, t } from '@arbol-ai/maximus';
import { checkSchema } from '@arbol-ai/maximus/schemas';
import { ItemsSchema, UnknownSkuSchema } from '@maximus-examples/pricing/contract';

/** POST /api/v1/quotes: what an order of these items would cost, as the pricing Worker prices them. */
export default defineHandler(
  async ({ env, principal, input, fail }) => {
    let priced;
    try {
      // The caller's verified principal travels as it is; pricing checks it and the items again.
      priced = await env.PRICING.quoteItems(principal, input);
    } catch {
      return fail('UPSTREAM_UNAVAILABLE');
    }
    if (priced.ok) {
      return { currency: priced.value.currency, totalCents: priced.value.totalCents };
    }
    const unknown =
      priced.error.code === 'UNKNOWN_SKU' ? checkSchema(UnknownSkuSchema, priced.error.data) : undefined;
    if (unknown?.success) {
      return fail('UNKNOWN_ITEM', unknown.data);
    }
    return fail(priced.error.retryable ? 'UPSTREAM_UNAVAILABLE' : 'INTERNAL_ERROR');
  },
  {
    description: 'Price the items of a prospective order. Nothing is reserved or charged.',
    effect: 'read',
    input: { items: ItemsSchema },
    output: { currency: t.Literal('USD'), totalCents: t.Integer({ minimum: 0 }) },
    failures: ['UNKNOWN_ITEM'],
  }
);
```

- Forward `principal` as the handler receives it. Never build a principal from input: the owner acts for
  whatever organization it names.
- A call that throws reached no answer: the owner is unreachable, or failed outside its pipeline. It is
  no `Result`, so catch it.
- A failure from the owner belongs to the owner's catalog, which the caller's output check would refuse
  unless the caller's catalog declares the same code. Translate it: name what the caller can fix in your
  own failure, keep what the owner may recover from retryable, and answer the rest as your own fault. Read
  a failure's `data` through its schema before you use it.
- The principal carries the caller's `requestId`, so the owner's logs and observations of the call carry
  the same request id as the caller's.

## Run and test both

Locally, start the owner first, each Worker in its own terminal, so the caller finds the owner in the local
development registry when it starts:

```sh
cd examples/worker-rpc/pricing && bun run dev   # http://localhost:5174
cd examples/worker-rpc/orders && bun run dev    # http://localhost:5173
```

The owner's tests call its route over HTTP in Node, as any route's tests do, beside the type test above.
The caller's tests stand in for the binding with an object that has the method, typed by the contract,
and check what it was called with:

```ts
// orders/tests/quotes.test.ts
import type { PricingService } from '@maximus-examples/pricing/contract';
import { vi } from 'vite-plus/test';

const token = 'test-development-token-for-local-tests';
/** The pricing binding as the tests stand it in: its one RPC method, which records each call. */
const pricing = { quoteItems: vi.fn<PricingService['quoteItems']>() };
const env = { DEVELOPMENT_TOKEN: token, PRICING: pricing } as unknown as Env;
```

[Testing](testing.md) covers both. Deploy the owner first, since the caller's binding names it.

## In a Worker composed by hand

A Worker composed by hand serves the same entrypoint: `createWorker(app).entrypoint`, exported under the
name the callers' bindings give as `exportName`. The operations declare `rpc` as routes do, and the
application's configuration lists `rpc.callers`. The same Worker can wrap its own entrypoint classes and
Durable Objects so they run inside the application's diagnostics; see
[Worker composition](worker-composition.md#entrypoints-and-durable-objects).
