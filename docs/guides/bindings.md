# Bindings

A binding is how the Worker reaches a Cloudflare resource: a KV namespace, a D1 database, an R2 bucket, a
queue, a Durable Object class, another Worker, Browser Run, a rate limiter or a secret. This guide declares
each kind in `vite.config.ts`, shows how `Env` types it, and covers where its data lives under `vp dev`,
which resources a deployment creates and how tests stand in for them.

## Declare a binding

Bindings are the `env` of `maximus()`, each made by a helper of `bindings` from `cf/config`, Cloudflare's
own configuration package:

```ts
// vite.config.ts
import { maximus } from '@arbol-ai/maximus/vite';
import { bindings } from 'cf/config';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [
    maximus({
      origin: 'https://notes.example.com',
      tokens: { issuer: 'https://auth.example.com/' },
      compatibilityDate: '2026-10-27',
      env: {
        NOTES: bindings.kv(),
        ATTACHMENTS: bindings.r2({ name: 'notes-attachments' }),
      },
    }),
  ],
});
```

Each key is the name the Worker reads the binding by. Prepare writes the global `Env` type in
`.maximus/env.d.ts` with Cloudflare's own inference, here `NOTES: KVNamespace` and
`ATTACHMENTS: R2Bucket`, so code that reads a binding nobody declared does not compile. Handlers receive
the bindings as `env`, and `context.ts` usually turns them into stores scoped to the caller's
organization, as [Getting started](../getting-started.md#give-every-handler-the-callers-notes) does.

An entry whose value is `false`, `null` or `undefined` is left out, so a binding can depend on a condition
the configuration evaluates. Two names are Maximus's own, and declaring either is refused:

- the development token's binding, `DEVELOPMENT_TOKEN` unless `tokens.development` names another, which
  `vp dev` alone declares: `DEVELOPMENT_TOKEN is the development token: Maximus declares it under vp dev
  alone, so no deployed Worker carries it.`
- `ASSETS` in a web app: `ASSETS serves the web app index.html starts: Maximus declares it.`

## Helpers and types

| Resource                                       | Declare                                                        | `Env` type                                                |
| ---------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------- |
| A Workers KV namespace                         | `bindings.kv()`                                                | `KVNamespace`                                             |
| A D1 database                                  | `bindings.d1({ name, id })`                                    | `D1Database`                                              |
| An R2 bucket                                   | `bindings.r2({ name })`                                        | `R2Bucket`                                                |
| A queue the Worker sends to                    | `bindings.queue({ name })`                                     | `Queue`, whose messages are `unknown`                     |
| One of the Worker's own Durable Object classes | `bindings.durableObject({ worker, exportName })`               | `DurableObjectNamespace` of that class                    |
| An entrypoint of another Worker                | `bindings.worker({ worker, exportName, props })`               | `Fetcher`                                                 |
| Another Maximus Worker's RPC methods           | `services: { PRICING: { worker, openapi } }` in `maximus()`    | `Service<PricingService>`, from the document it publishes |
| Browser Run                                    | `bindings.browser()`                                           | `BrowserRun`                                              |
| A rate limiter                                 | `bindings.rateLimit({ namespace, simple: { limit, period } })` | `RateLimit`                                               |
| A secret                                       | `bindings.secret()`                                            | `string`                                                  |
| A plain value                                  | `bindings.text('…')` or `bindings.json({ … })`                 | The value's own type                                      |

`cf/config` has a helper for the rest of Cloudflare's bindings too, among them Workers AI (`ai`),
Vectorize (`vectorize`), Hyperdrive (`hyperdrive`), Analytics Engine (`analyticsEngineDataset`), Workflows
(`workflow`) and sending email (`sendEmail`). Each is typed the same way.

## Type what inference cannot

Inference reads the configuration as data. A queue binding names its queue but not the type of its
messages, and a binding to another Worker names that Worker but not its entrypoint's methods. State a
queue's message type once, in the module that owns it, by adding to the global `Env`:

```ts
// src/reminders.ts
import { OrganizationIdSchema, t, UuidSchema } from '@arbol-ai/maximus';
import type { Static } from '@arbol-ai/maximus';

/** A message of the reminders queue: the reminder to deliver and its organization. */
export const ReminderMessageSchema = t.Object(
  { organizationId: OrganizationIdSchema, reminderId: UuidSchema },
  { additionalProperties: false }
);
export type ReminderMessage = Static<typeof ReminderMessageSchema>;

declare global {
  interface Env {
    /** The reminders queue, which vite.config.ts binds by name. */
    REMINDERS: Queue<ReminderMessage>;
  }
}
```

The module must belong to the TypeScript project, as everything in `src/` does in the starter's
`tsconfig.json`. [`examples/queue-reminders/src/reminders.ts`](../../examples/queue-reminders/src/reminders.ts)
does exactly this. Another Maximus Worker's methods need none of it: `services` types them from the RPC
document that Worker publishes (see [Other Workers](#other-workers)). Nor does a binding to one of the
Worker's own Durable Object classes: `Env` types it by its class.

## Workers KV, R2 and queues

`bindings.kv()` without an `id`, `bindings.r2({ name })` and `bindings.queue({ name })` need nothing
created beforehand: the first deployment creates the namespace, the bucket or the queue. To bind a KV
namespace that exists already, give its id: `bindings.kv({ id: '<namespace id>' })`.

A queue binding sends messages; a module of `queues/` named after the queue consumes them. See
[Background work](background-work.md#consume-a-queue).

## D1

A D1 database is created before the Worker that reads it, so that its migrations can run first. Bind it by
its id, and keep a fixed local id for `vp dev`:

```ts
/** The id of the local database, which no Cloudflare account holds. */
const LOCAL_DATABASE = '00000000-0000-4000-8000-00000000d1d1';

// in maximus():
env: {
  NOTES_DB: bindings.d1({ name: 'notes', id: process.env.NOTES_DB_ID ?? LOCAL_DATABASE }),
},
```

Migrations are the SQL files of `migrations/`, and `cf d1 migrations apply <id>` applies those the
database has not run yet. Two scripts apply them, to the local database `vp dev` uses and to the deployed
one:

```json
{
  "scripts": {
    "migrate:local": "cf d1 migrations apply 00000000-0000-4000-8000-00000000d1d1 --local --persist-to .cloudflare/state",
    "migrate": "cf d1 migrations apply $NOTES_DB_ID"
  }
}
```

Run `bun run migrate:local` once before you call the API under `vp dev`. Before the first deployment,
create the database, apply the migrations to it and build with its id:

```sh
bunx cf d1 create --name notes      # prints the database's id
export NOTES_DB_ID=<that id>
bun run migrate
bun run deploy
```

[`examples/d1-notes`](../../examples/d1-notes) keeps notes in D1 with every row keyed by organization and
read back through its schema.

## Durable Objects

A Durable Object class is a module of `durable-objects/`, declared in `exports` and bound with
`bindings.durableObject({ worker, exportName })`, where `worker` is the Worker's own name. `Env` types the
binding by the class, so a stub's methods are checked. See [Durable Objects](durable-objects.md).

## Other Workers

A Maximus Worker serves its RPC methods on the entrypoint `Service` and publishes them in its RPC document,
`openapi.rpc.json`. Bind it in `services`, by its Worker's name and that document:

```ts
services: {
  PRICING: { worker: 'example-pricing', openapi: '../pricing/openapi.rpc.json' },
},
```

`maximus()` declares the binding to its `Service` entrypoint with the props `{ caller }`, this service's
`name`, which the other Worker admits in its `rpc.callers`, and `maximus prepare` types `env.PRICING` from
the document, in `.maximus/services/pricing.ts`. [Worker RPC](worker-rpc.md) covers both sides.

`bindings.worker` binds an entrypoint of any other Worker of the same account, typed in the global `Env` by
an interface of its methods:

```ts
env: {
  SEARCH: bindings.worker({ worker: 'search', exportName: 'SearchEntrypoint' }),
},
```

Deploy the bound Worker first. Under `vp dev`, start its development server before this one's, and the
binding reaches it on your machine.

## Browser Run

`bindings.browser({ dev: { remote: true } })` makes the binding reach your account's Browser Run under
`vp dev` too, so sign in first with `bunx cf auth login`, or set `CLOUDFLARE_API_TOKEN`. Tests need none of
it: they stand in for the binding. [`examples/browser-pages`](../../examples/browser-pages) reads pages as
Markdown and captures them as PNG attachments.

## Rate limiting

Name a rate limiting binding in `maximus()`'s `rateLimit`, and every HTTP and MCP call passes it after its
token is verified, counted per organization and actor:

```ts
env: { LIMITS: bindings.rateLimit({ namespace: '1001', simple: { limit: 100, period: 60 } }) },
rateLimit: { binding: 'LIMITS' },
```

A call over the limit answers `429` with `RATE_LIMITED` and `Retry-After: 60`, or the seconds
`rateLimit.retryAfter` states. See [Configuration](../reference/configuration.md).

## Secrets and plain values

`bindings.secret()` declares a value the Worker reads but the configuration never holds, such as an API
key: `Env` types it as a `string`. Under `vp dev` its value comes from `.dev.vars`; a deployment uploads it,
for example with `cf deploy --secrets-file <file>`, as [Deploying](deploying.md) describes.

`bindings.text('…')` and `bindings.json({ … })` hold their values in `vite.config.ts`, the build and the
generated types, so they are for configuration anyone may read, never for a credential.

## Local state and .dev.vars

Under `vp dev`, the stores are local: KV namespaces, D1 databases, R2 buckets and Durable Object storage
live in `.cloudflare/state/`, which `vp dev` and `vp preview` keep between runs and Git ignores. Delete the
folder to start empty. Queues run locally too: a message the Worker sends reaches its consumer within the
same server.

`.dev.vars` holds the local values of secrets, one `NAME=value` per line, and Git ignores it. `maximus init`
writes it with a fresh development token, readable only by its owner:

```text
DEVELOPMENT_TOKEN=<64 hexadecimal characters>
```

Only the secrets `env` declares take their values from it, together with the development token that
`vp dev` declares; any other line reaches no binding. A declared secret missing from it gets a warning when
the server starts. When there is no `.dev.vars`, secrets take their values from `.env` files and the
environment instead.

## What a deployment creates

| Binding                | Before the first deployment                                                    |
| ---------------------- | ------------------------------------------------------------------------------ |
| KV, without an `id`    | Nothing: the deployment creates the namespace.                                 |
| R2                     | Nothing: the deployment creates the bucket.                                    |
| A queue                | Nothing: the deployment creates the queue and subscribes its consumer.         |
| D1                     | Create the database with `cf d1 create`, bind its id and apply the migrations. |
| A Durable Object class | Declare it in `exports`; the deployment creates its storage.                   |
| Another Worker         | Deploy that Worker.                                                            |
| A secret               | Upload its value.                                                              |

[Deploying](deploying.md) covers the deployment itself.

## Stand-ins in tests

A test in Node has no Cloudflare resources. It passes the handler an `env` of its own, whose bindings are
stand-ins for the methods the code under test calls:

```ts
import { testNamespace } from './kv.ts';

const token = 'test-development-token-for-local-tests';
const env = { DEVELOPMENT_TOKEN: token, NOTES: testNamespace() } as unknown as Env;
```

The examples hold one stand-in of each kind: Workers KV over a `Map`
([`examples/tasks/tests/kv.ts`](../../examples/tasks/tests/kv.ts)), D1 over Node's SQLite with the
migrations applied ([`examples/d1-notes/tests/d1.ts`](../../examples/d1-notes/tests/d1.ts)), R2
([`examples/r2-documents/tests/r2.ts`](../../examples/r2-documents/tests/r2.ts)), a queue that records what
it is sent ([`examples/queue-reminders/tests/stand-ins.ts`](../../examples/queue-reminders/tests/stand-ins.ts))
and a Durable Object namespace
([`examples/do-appointments/tests/durable-objects.ts`](../../examples/do-appointments/tests/durable-objects.ts)).
See [Testing](testing.md).
