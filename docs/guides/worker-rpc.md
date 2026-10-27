# Worker RPC

A route can also be a method that other Workers of your Cloudflare account call through a
[Service Binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/),
with no HTTP request, token or JSON body in between. This guide follows
[`examples/worker-rpc`](../../examples/worker-rpc), where the Worker `orders` prices an order by calling
the Worker `pricing`: how the owner serves a route over RPC and publishes the document its callers bind to,
and how a caller binds it, typed, without importing anything of the owner's project.

## Serve a route over RPC

The owner names the services allowed to call it in `maximus()`, by the name each one has:

```ts
// pricing/vite.config.ts
import { maximus } from '@arbol-ai/maximus/vite';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [
    maximus({
      name: 'example-pricing',
      namespace: 'pricing',
      origin: 'https://example-pricing.example.workers.dev',
      tokens: { issuer: 'https://auth.example.com/' },
      compatibilityDate: '2026-10-26',
      rpc: { callers: ['example-orders'] },
    }),
  ],
});
```

and each route it serves over RPC says so in its contract:

```ts
// pricing/routes/v1/quotes.post.ts
import { defineHandler } from '@arbol-ai/maximus';

import { priceItems } from '#src/catalog.ts';
import { ItemsSchema, QuoteSchema } from '#src/quotes.ts';

/** POST /api/v1/quotes, and the RPC method quoteItems the orders Worker calls. */
export default defineHandler(
  ({ input, fail }) => {
    const priced = priceItems(input.items);
    if (!priced.ok) {
      return fail('UNKNOWN_SKU', { index: priced.unknownIndex });
    }
    return priced.quote;
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

`rpc: true` admits every caller of `rpc.callers`; `rpc: { callers: ['example-orders'] }` admits only those
it lists, each of which `rpc.callers` must name, or the Worker does not start:
`Operation "<name>": RPC callers must be allowed by the application.` A tool of `mcp/tools/` takes `rpc`
too.

The method's name is the operation's: what the method does to what the path names, `createQuote`, unless
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

## Publish the RPC document

The owner publishes what its callers bind to as an OpenAPI document, written from its routes:

```sh
cd pricing && bunx maximus openapi
# openapi.json was written: 0 operations. openapi.rpc.json was written: 1 operation.
```

`openapi.json` is the public document the Worker serves. `openapi.rpc.json` lists every operation the
Worker serves over native RPC, internal ones and tools included, each as `POST /rpc/<method>` whose body is
the method's whole input, with its answer and its failures named as in the HTTP document
(`QuoteItemsInput`, `QuoteResponse`, `UnknownSkuError`) and `x-rpc-callers` naming who may call it.
[Wire formats](../reference/wire-formats.md#the-rpc-document) describes it. Commit both files and check
them in CI with `bunx maximus openapi --check`, which fails when the routes changed and the files did not:
the examples run it in their `openapi` script.

## Bind and call the owner

The caller names the owner's Worker and its RPC document in `services`. The document is a file of the
caller's repository: in a monorepo, the path to the owner's own; in another repository, a copy the
owner's CI publishes and yours updates.

```ts
// orders/vite.config.ts
import { maximus } from '@arbol-ai/maximus/vite';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [
    maximus({
      name: 'example-orders',
      namespace: 'orders',
      origin: 'https://example-orders.example.workers.dev',
      tokens: { issuer: 'https://auth.example.com/' },
      compatibilityDate: '2026-10-26',
      services: {
        PRICING: { worker: 'example-pricing', openapi: '../pricing/openapi.rpc.json' },
      },
    }),
  ],
});
```

`maximus()` binds `PRICING` to the owner Worker's `Service` entrypoint, with props that name this service,
`{ caller: 'example-orders' }`, the name the owner admits in its `rpc.callers`. The props belong to the
deployment, never to a request. `maximus prepare` reads the document and writes
`.maximus/services/pricing.ts`, which types the binding, so `env.PRICING` is
`Service<PricingService>`:

```ts
// .maximus/services/pricing.ts (generated)
export interface PricingService extends WorkerEntrypoint {
  /** Create a quote: Price a list of catalog items for the calling organization. */
  quoteItems(principal: Principal, input: QuoteItemsInput): Promise<Result<Quote, QuoteItemsFailure>>;
}

export type QuoteItemsFailure =
  | InvalidInputFailure
  | UnknownSkuFailure
  | …;

export interface UnknownSkuFailure {
  code: 'UNKNOWN_SKU';
  message: string;
  retryable: false;
  data: UnknownSkuFailureData;
}
```

Every type comes from the document: the caller imports nothing of the owner's project, and its type check
fails the moment the owner's document changes in a way its calls do not follow. A route of the caller then
calls the method with the principal its own call was verified with, and answers in its own catalog:

```ts
// orders/routes/v1/quotes.post.ts
import { defineHandler, t } from '@arbol-ai/maximus';
import type { Result } from '@arbol-ai/maximus';

import type { Quote, QuoteItemsFailure } from '#maximus/services/pricing';
import { OrderItemsSchema } from '#src/items.ts';

/** POST /api/v1/quotes: what an order of these items would cost, as the pricing Worker prices them. */
export default defineHandler(
  async ({ env, principal, input, fail }) => {
    let priced: Result<Quote, QuoteItemsFailure>;
    try {
      // The caller's verified principal travels as it is; pricing checks it and the items again.
      priced = await env.PRICING.quoteItems(principal, input);
    } catch {
      return fail('UPSTREAM_UNAVAILABLE');
    }
    if (priced.ok) {
      return { currency: priced.value.currency, totalCents: priced.value.totalCents };
    }
    const failure = priced.error;
    if (failure.code === 'UNKNOWN_SKU') {
      return fail('UNKNOWN_ITEM', { index: failure.data.index });
    }
    if (failure.retryable) {
      return fail('UPSTREAM_UNAVAILABLE');
    }
    return fail('INTERNAL_ERROR');
  },
  {
    description: 'Price the items of a prospective order. Nothing is reserved or charged.',
    effect: 'read',
    input: { items: OrderItemsSchema },
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
  own failure, keep what the owner may recover from retryable, and answer the rest as your own fault. Its
  code narrows its `data`, as the document types it; the caller's `fail` still checks the data its own
  failure declares, so an owner deployed with another contract than the document's answers
  `INTERNAL_ERROR`, never wrong data.
- The caller's input is its own API's, declared with its own schemas: the compiler holds it to the owner's
  input type where the caller passes it.
- The principal carries the caller's `requestId`, so the owner's logs and observations of the call carry
  the same request id as the caller's.

Several services in one repository each bind the others the same way, each to the document the other
publishes: one `services` entry per binding, typed in its own `.maximus/services/<binding>.ts`. A service
that is both an owner and a caller lists its callers in `rpc.callers` and its owners in `services`.

## Run and test both

Locally, start the owner first, each Worker in its own terminal, so the caller finds the owner in the local
development registry when it starts:

```sh
cd examples/worker-rpc/pricing && bun run dev   # http://localhost:5174
cd examples/worker-rpc/orders && bun run dev    # http://localhost:5173
```

The owner's tests call its route over HTTP in Node, as any route's tests do, and check that the committed
RPC document is the one its routes declare:

```ts
// pricing/tests/quotes.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createRpcOpenApi } from '@arbol-ai/maximus';
import { expect, it } from 'vite-plus/test';

import { app } from '#maximus/app';

it('publishes the RPC document its callers bind to, current with its routes', () => {
  const published: unknown = JSON.parse(
    readFileSync(join(import.meta.dirname, '../openapi.rpc.json'), 'utf-8')
  );
  expect(published).toStrictEqual(createRpcOpenApi(app));
});
```

The caller's tests stand in for the binding with an object that has the method, typed by the generated
module, and check what it was called with:

```ts
// orders/tests/quotes.test.ts
import { vi } from 'vite-plus/test';

import type { PricingService } from '#maximus/services/pricing';

const token = 'test-development-token-for-local-tests';
/** The pricing binding as the tests stand it in: its one RPC method, which records each call. */
const pricing = { quoteItems: vi.fn<PricingService['quoteItems']>() };
const env = { DEVELOPMENT_TOKEN: token, PRICING: pricing } as unknown as Env;
```

[Testing](testing.md) covers both. Deploy the owner first, since the caller's binding names it.

## In a Worker composed by hand

A Worker composed by hand serves the same entrypoint: `createWorker(app).entrypoint`, exported under the
name the callers' bindings give as `exportName`. The operations declare `rpc` as routes do, and the
application's configuration lists `rpc.callers`; `createRpcOpenApi(app)` builds its RPC document. A caller
composed by hand declares the binding with `bindings.worker({ worker, exportName: 'Service', props: { caller } })`
and types it itself. The same Worker can wrap its own entrypoint classes and Durable Objects so they run
inside the application's diagnostics; see
[Worker composition](worker-composition.md#entrypoints-and-durable-objects).
