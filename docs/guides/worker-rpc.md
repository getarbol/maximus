# Worker RPC

Native RPC lets one Worker call another's operations through a
[Service Binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/),
without HTTP, tokens or JSON parsing. Maximus turns each `rpc` operation into a typed method on a
named `WorkerEntrypoint`. The [`worker-rpc`](../../examples/worker-rpc) example runs two Workers
locally.

## The owner: expose operations

1. List the deployments allowed to call, by the name their binding will carry:

   ```ts
   export const app = maximus<Env>({
     // ...
     rpc: { callers: ['orders'] },
   });
   ```

2. Opt each operation in. `rpc: true` admits every application caller; `{ callers }` narrows it to a
   subset of them.

   ```ts
   .operation(
     'quoteItems',
     {
       scope: 'pricing:quotes:read',
       effect: 'read',
       title: 'Quote items',
       description: 'Price a list of catalog items for the calling organization.',
       input: QuoteInputSchema,
       output: QuoteSchema,
       rpc: true, // or { callers: ['orders'] }
     },
     handler
   )
   ```

3. Export the entrypoint under a name:

   ```ts
   const worker = createWorker(app);

   export const PricingService = worker.entrypoint;
   export default worker.handler;
   ```

An operation can be RPC-only: declare `rpc` and no `http`. Operations without `rpc` are absent from
the entrypoint and from its type.

## The caller: bind and call

Bind the owner's entrypoint in the caller's `cloudflare.config.ts`. `props` name this deployment; the
owner admits only callers its operations list. The owner declares the entrypoint among its exports
(`exports: { PricingService: exports.worker() }`) and exports its Worker definition, so the binding
names a Worker and an entrypoint that exist:

```ts
import { pricingWorker } from '../pricing/cloudflare.config.ts';

env: {
  PRICING: bindings.worker({
    worker: pricingWorker,
    exportName: 'PricingService',
    props: { caller: 'orders' },
  }),
},
```

Type the binding with the owner's entrypoint and call its methods with a principal and an input:

```ts
import type { PricingService } from '../../pricing/src/index';

export interface Env {
  PRICING: Service<typeof PricingService>;
}
```

```ts
async ({ env, principal }, input) => {
  let quote;
  try {
    // Forward the principal this call was verified with; never build one from input.
    quote = await env.PRICING.quoteItems(principal, { items: input.items });
  } catch {
    return err(standardErrors.upstreamUnavailable.create());
  }
  if (!quote.ok) {
    // The owner's failures belong to its catalog: translate them into yours.
    return err(
      quote.error.retryable ? standardErrors.upstreamUnavailable.create() : standardErrors.internal.create()
    );
  }
  return ok({ totalCents: quote.value.totalCents, currency: quote.value.currency });
};
```

Each method is `(principal, input) => Promise<Result<Output, Failure>>`. `Service<typeof X>` gives
you the input and output types; a type check that the method's return is not `never` catches a
non-serializable signature early (see [Testing](testing.md#native-rpc-types)).

A failure from the owner is a value of the owner's catalog. Returning it unchanged from your own
operation fails your output check unless your catalog declares the same code, so translate it, as
above, or declare the codes you forward. A thrown call (the owner is unreachable or crashed) is not a
`Result`; catch it.

## What the owner checks

For every RPC call, before any of your code runs:

1. The binding's props are exactly `{ caller }`, and `caller` is admitted by the operation. Anything
   else is `UNAUTHORIZED`.
2. The principal matches the principal schema exactly: `actorId`, `actorKind`, `organizationId`
   (1 to 128 letters, digits, `_` and `-`) and a UUID `requestId`. Anything else is `UNAUTHORIZED`.
3. Execution then runs as on every transport: `actorKinds`, input decoding, preparation, middleware,
   the handler and the output check.

**Scopes are not checked over ordinary RPC.** There is no token: the owner trusts the calling
deployment, identified by props that only your account's configuration can set, and the principal it
forwards. `context.authority` is absent, so an operation with `conditionalScopes` fails closed with
`FORBIDDEN`. When the owner must verify the original caller's authority itself, call its HTTP route
with the caller's own access token instead (`context.authority.token` on the calling side).

Treat everyone who can deploy a Worker with that binding as able to call the owner as any principal.
Name callers narrowly and give each operation the smallest `callers` list it needs.

## Other entrypoints and Durable Objects

`createWorker` also wraps your own classes with the same diagnostics:

```ts
import { WorkerEntrypoint, DurableObject } from 'cloudflare:workers';

class ReportsEntrypoint extends WorkerEntrypoint<Env> {
  async summary(organizationId: string) {
    // ...
  }
}
class Session extends DurableObject<Env> {
  // ...
}

export const ReportsService = worker.service(ReportsEntrypoint);
export const SessionObject = worker.durableObject(Session);
```

A wrapped class keeps its methods and type. Maximus does not validate the arguments of your own
methods; validate them where they enter. Keep Durable Object class names and migration tags stable
across releases: renaming a class orphans its stored state.

## Run two Workers locally

Under `cf dev`, the caller's Vite build runs the owner beside it as an auxiliary Worker, which answers
the binding; `devOnly` keeps it out of the caller's production build, since each Worker deploys from
its own directory. In `orders/vite.config.ts`:

```ts
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

import { pricingWorker } from '../pricing/cloudflare.config.ts';

export default defineConfig({
  plugins: [cloudflare({ auxiliaryWorkers: [{ config: pricingWorker, devOnly: true }] })],
});
```

Vite loads the owner's configuration on its own, so that configuration names its entrypoint by a path
(`fileURLToPath(new URL('src/index.ts', import.meta.url))`) rather than a `cf-worker` import.

## Reference

- [Operation options](../reference/operations.md#rpc): `rpc`.
- [Configuration](../reference/configuration.md#application): `rpc.callers`.
- [Wire formats](../reference/wire-formats.md#native-rpc): props and results.
