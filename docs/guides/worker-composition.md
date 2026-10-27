# Worker composition

A project's Worker is generated from its files. This guide covers what the Worker serves besides its
routes and tools, and how to compose a Worker by hand from the application builder: pages and plain
routes that answer without a token, provider webhooks, mounted APIs, transports, hooks, static assets and
the Worker's other entrypoints. Read it when a project's conventions do not cover what you need to serve.

## Pages

A file of `pages/` answers `GET` and `HEAD` at a fixed path outside the API, without a token: a landing
page, a status page, a `robots.txt`. Its default export is a plain route, a function of the request:

```ts
// pages/index.ts
import type { HttpRoute } from '@arbol-ai/maximus';

/** GET /: a public page outside the API. Business data belongs to authenticated routes. */
const home: HttpRoute<Env> = () =>
  Promise.resolve(
    new Response('Hello World\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } })
  );

export default home;
```

A page answers `HEAD` as it answers `GET`, without the body, and any other method with `405` and
`allow: GET, HEAD`, without running. It may set its own `cache-control`; any other answer is
`private, no-store`. A page cannot claim a path the Worker answers otherwise: the API's base path and
everything below it, the health check, the versioned paths, `/.well-known` and `/mcp`. Such a page is
refused with `Page path is reserved or malformed: <path>. Move the API with http.basePath.`
[Project structure](project-structure.md) shows how a file's name gives its path.

A page owns its answer completely: it receives no principal and appears in no OpenAPI document. Data of an
organization belongs to routes, which require a token.

## A Worker composed by hand

The application builder, `maximus()` from `@arbol-ai/maximus`, builds in code the application a project
builds from its files, and `createWorker` from `@arbol-ai/maximus/workers` serves it. Compose a Worker by
hand when Maximus is one part of a Worker you build yourself, or when the Worker needs what a project
does not declare: mounted protocols, hooks around requests and operations, pinned origins, or
entrypoints of your own. A project receives a provider's webhooks on a
[page named for its method](project-structure.md#receive-a-webhook).

```ts
import { defineErrors, maximus, ok, readBodyBytes, standardErrors, t } from '@arbol-ai/maximus';
import type { HttpRoute } from '@arbol-ai/maximus';
import { mcp } from '@arbol-ai/maximus/mcp';
import { verifyStandardWebhook } from '@arbol-ai/maximus/webhooks';
import { createWorker } from '@arbol-ai/maximus/workers';

/** The bindings this Worker declares. */
interface Env {
  NOTES: KVNamespace;
  PAYMENT_EVENTS: Queue;
  PAYMENTS_WEBHOOK_SECRET: string;
}

const errors = defineErrors({
  noteNotFound: { code: 'NOTE_NOT_FOUND', status: 404, message: 'The note does not exist.' },
});

export const app = maximus<Env>({
  name: 'notes',
  namespace: 'notes',
  title: 'Notes',
  version: '1.0.0',
  origin: 'https://notes.example.com',
  tokens: { issuer: 'https://auth.example.com/', audience: 'https://notes.example.com' },
  errors,
  rpc: { callers: [] },
  mcp: { instructions: 'notes keeps short notes for the organization your token belongs to.' },
})
  .derive(async ({ env, principal }) => ok({ kv: env.NOTES, prefix: `notes/${principal.organizationId}/` }))
  .operation(
    'countNotes',
    {
      scope: 'notes:notes:read',
      effect: 'read',
      title: 'Count notes',
      description: "Count the organization's notes.",
      input: t.Object({}, { additionalProperties: false }),
      output: t.Object({ count: t.Integer({ minimum: 0 }) }, { additionalProperties: false }),
      http: { method: 'GET', path: '/v1/notes/count' },
      mcp: { name: 'count_notes', idempotent: true },
    },
    async ({ kv, prefix }) => ok({ count: (await kv.list({ prefix })).keys.length })
  )
  .build();

/** A provider's signed deliveries: verified on their exact bytes, then queued for the work they ask for. */
const paymentWebhook: HttpRoute<Env> = async (request, env, context) => {
  if (request.method !== 'POST') {
    return context.fail(standardErrors.methodNotAllowed.create(), { allow: 'POST' });
  }
  const body = await readBodyBytes(request, { maxBytes: 64 * 1024 });
  if (!body.ok) {
    return context.fail(
      body.error.data.reason === 'too_large'
        ? standardErrors.tooLarge.create()
        : standardErrors.invalidInput.create()
    );
  }
  const verified = await verifyStandardWebhook({
    body: body.value,
    headers: request.headers,
    secret: env.PAYMENTS_WEBHOOK_SECRET,
  });
  if (!verified.ok) {
    return context.fail(standardErrors.unauthorized.create(), { 'www-authenticate': 'Signature' });
  }
  await env.PAYMENT_EVENTS.send({
    deliveryId: verified.value.id,
    body: new TextDecoder().decode(body.value),
  });
  return new Response(null, { status: 204 });
};

const worker = createWorker(app, {
  transports: [mcp()],
  routes: { '/webhooks/payments': paymentWebhook },
  http: { basePath: '/api' },
});

export default worker.handler;
export const Service = worker.entrypoint;
```

The builder declares each operation with its name, its definition and its handler, which receives the
prepared context and the decoded input and answers a `Result`: `ok(value)`, or `err(failure)` from the
catalog. A definition states everything a project derives: `scope`, `effect`, `title` and `description`,
`http: { method, path }`, `mcp: { name, idempotent }`. [Concepts](../concepts.md#the-application-underneath)
introduces the builder, [Context and middleware](middleware-and-context.md#in-a-worker-composed-by-hand)
shows `.derive()`, `.use()` and `.mount()`, and
[Route and operation options](../reference/operations.md) lists every field. `.build()` checks every
rule and refuses a broken application with a `TypeError` that names the rule.

`maximus()` in `vite.config.ts` always builds the Worker it generates, from `.maximus/entry.ts`. A Worker
composed by hand is built as any other Worker, with its module as the entry, and needs the
`nodejs_compat` compatibility flag: Maximus keeps each call's diagnostics in `node:async_hooks`.

### createWorker

`createWorker(app, options)` serves the application and composes the rest of the Worker:

| Option       | Meaning                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transports` | Protocols served beside the operations, each at one exact path: `mcp()` from `@arbol-ai/maximus/mcp`.                                                         |
| `routes`     | [Plain routes](#plain-routes), by exact path.                                                                                                                 |
| `http`       | The options of the HTTP handler: [mounts](#mounted-apis), [hooks](#hooks), [base path and health](#base-path-and-health), `origins` and request `middleware`. |
| `assets`     | [Static assets](#static-assets) from an assets binding.                                                                                                       |
| `handlers`   | The Worker's other handlers: `scheduled`, `queue`, `email` and the rest of `ExportedHandler`.                                                                 |

It returns:

| Member                 | Meaning                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `handler`              | The Worker's default export: `fetch`, and the `handlers` given.                                  |
| `entrypoint`           | A `WorkerEntrypoint` class with one method per operation that declares `rpc`. Export it by name. |
| `service(Class)`       | Your own `WorkerEntrypoint` class, wrapped to run inside the application's diagnostics.          |
| `durableObject(Class)` | Your own Durable Object class, wrapped the same way.                                             |

Every other handler runs inside the application's diagnostics too: a failure it throws is reported by its
safe description, then thrown on for the platform to retry or record. A project's Worker is
`createProjectWorker(app, { pages, crons, queues, email }, options)` from `@arbol-ai/maximus/project`,
which adds the project's pages and event handlers to `createWorker`.

### createHttpHandler

`createHttpHandler(app, options)` from `@arbol-ai/maximus` is the same HTTP handler without the Workers
runtime: a function `(request, env, background?) => Promise<Response>`, for tests in Node and for code that
answers HTTP outside a Worker. Its options are `createWorker`'s `http` options, plus `transports`, `routes`
and `annotate(operation, requestId)`, which is called before each operation runs while telemetry is on;
`createWorker` uses it to annotate the active trace span. A project's tests import the handler
`.maximus/http.ts` builds the same way; see [Testing](testing.md).

One `http` option exists for tests alone: `verify(token)` returns a token's claims in place of verifying
the token, while the claim mapping and the scope checks still apply. Never deploy it.

## Plain routes

A plain route answers one exact path, with any method, outside token admission: a provider's webhook
signs its body, a signed download link carries its own signature, an OAuth callback carries a code. It is
a function `(request, env, context) => Promise<Response>`, typed `HttpRoute<Env>`, in `createWorker`'s
`routes`.

- It receives no principal, appears in no OpenAPI document, and owns its authentication completely: it
  verifies a signature or a token before it treats any of the request as data.
- `context.requestId` is the request's id, `context.fail(failure, headers?)` answers a failure of the
  catalog in the standard envelope, and `context.waitUntil(promise)` keeps best-effort work running after
  the answer. Work that must happen belongs in a queue, as the webhook above does.
- It may set its own `cache-control`, as a signed file link may; any other answer is `private, no-store`.
  An exception it throws answers `INTERNAL_ERROR`.
- Its path is exact and made of unreserved characters. It cannot claim a [reserved path](#reserved-paths)
  or an operation's route, or it is refused with `Route path is reserved or malformed: <path>`. A plain
  route may sit below a transport's path, such as `/mcp/other`, since a transport answers its exact path
  alone.

A plain route that accepts the API's own tokens verifies them with `createTokenAuthorization`, which
admits a request by its bearer token and a scope, as the API does:

```ts
import { createTokenAuthorization } from '@arbol-ai/maximus';
import type { HttpRoute } from '@arbol-ai/maximus';

const authorize = createTokenAuthorization(app.tokens);

const exportNotes: HttpRoute<Env> = async (request, env, context) => {
  const caller = await authorize(request, 'notes:notes:read');
  if (!caller.ok) {
    return context.fail(caller.error);
  }
  // caller.value: { actorId, actorKind, organizationId, scopes, client? }
  return new Response(`notes of ${caller.value.organizationId}\n`);
};
```

Its third argument is the resolution context `tokens.resolve` receives, and its fourth, `'all'`,
requires every scope of a list. Without the third, it never accepts the development token.

## Verify a webhook

`@arbol-ai/maximus/webhooks` verifies the three signature schemes providers use, on the request's raw
bytes. Read them with `readBodyBytes` or `readBodyText` and a byte limit, verify them, and only then parse
them:

| Function                     | Scheme                                                                                                                                                                                  | Answers                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `verifyHmacSignature`        | An HMAC-SHA256 of the body in one header, hex or base64, with an optional `prefix` such as `sha256=`.                                                                                   | `null`                                                           |
| `verifyTimestampedSignature` | A `t=<seconds>,v1=<hex>` header signing `<t>.<body>`, with the signature `labels` to accept, such as `['v1']`.                                                                          | `{ timestamp }`                                                  |
| `verifyStandardWebhook`      | [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks): `webhook-id`, `webhook-timestamp` and `webhook-signature`, or their `svix-` names, with a `whsec_` secret. | `{ id, timestamp }`, the id being the delivery's idempotency key |

Each answers a `Result`. A refused signature is the failure `WEBHOOK_SIGNATURE_INVALID`, not retryable,
whose `data.reason` says why: `missing`, `malformed`, `expired` or `mismatch`. It carries nothing else:
no body, header value or secret. The two timestamped schemes refuse a timestamp more than five minutes
from the current time, in either direction, unless `toleranceSeconds` says otherwise, and a header with
more than eight signatures, several more than a provider rotating its secret sends. A missing or empty
secret is the deployment's mistake, not the sender's: the verifier throws
`A webhook secret is required; check the binding that holds it.` before it reads any header, and the
route answers `INTERNAL_ERROR`.

`WEBHOOK_SIGNATURE_INVALID` is not a failure of the standard catalog, and `context.fail` answers only
failures of the application's catalog: answer a refused delivery with one of those, as the webhook above
answers `UNAUTHORIZED`. Then record the delivery durably, by its id when the scheme has one, and answer
quickly: do the work it asks for in a queue consumer.

In a project, the same handler is a page named for its method, `pages/webhooks/payments.post.ts`, and
the Worker answers any other method with `405` before the page runs; a plain route answers every method,
so it checks the method itself, as the webhook above does.

## Mounted APIs

`http.mounts` hands a whole path namespace to a function with a plain route's signature, for a protocol
of its own:

```ts
http: { mounts: { '/files': serveFiles, '/files/archive': serveArchive } },
```

A mount answers its prefix and every slash-delimited path below it, `/files` and `/files/2026/report.pdf`
but never `/files-extra`, with any method and outside token admission. When mounts nest, the longest
prefix answers. A mount may set its own `cache-control`, as a plain route may. It cannot overlap a reserved
path, a transport, a plain route or an operation's route: such a mount is refused with
`Mount path is reserved or malformed: <prefix>`.

## Transports

A transport serves a protocol at one exact path, beside the operations, after admitting the request as
the API admits a call: its token and the transport's scope, the rate limit and a body limit.
`mcp()` from `@arbol-ai/maximus/mcp` is one (see [MCP](mcp.md)). A transport of your own implements
`HttpTransport`: its `path`, the `scope` a caller needs given the namespace, optionally the
`maxBodyBytes` it admits, and `handle(context)`, which receives the admitted request and the verified
caller, and `invoke`, which runs an operation through the shared execution path. Transports stay at
their absolute paths whatever the base path; two at one path, or one below another, are refused, and a
Worker serves one MCP transport at most.

## Hooks

```ts
http: {
  origins: ['https://notes.example.com'],
  before: async (request) => {
    const url = new URL(request.url);
    return url.hostname === 'www.notes.example.com'
      ? Response.redirect(`https://notes.example.com${url.pathname}${url.search}`, 308)
      : null;
  },
},
```

| Option            | Runs                                                                                                                                                                                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `origins`         | First: a request to any other origin answers `404` before anything else. Exact HTTPS origins, or the handler is refused with `HTTP origins must be exact HTTPS origins.`                                                                                                                                    |
| `middleware`      | Around every request after origin pinning: the request middleware of [Context and middleware](middleware-and-context.md#request-middleware), as functions.                                                                                                                                                  |
| `before`          | `before(request, env, context)`, for every request, before any route: answer a `Response`, which keeps its own `cache-control`, or `null` to continue. For canonical redirects and product-wide admission.                                                                                                  |
| `aroundOperation` | `aroundOperation(request, env, { name, effect }, run)`, around a matched HTTP operation alone: call `run(scopedEnv)` once, and token admission, the body and execution run inside it with that environment. A second call answers `INTERNAL_ERROR`. MCP, plain routes and discovery do not pass through it. |
| `fallback`        | `fallback(request, env, context)`, for a path outside every namespace the Worker owns: the base path, the versioned paths, `/.well-known` and each transport's. A miss inside them stays a `404`, so a mistyped API path never receives a web page.                                                         |

## Base path and health

`http.basePath` serves the operations and the service's own documents below a prefix, `/api/v1/notes` and
`/api/openapi.json`; a project's is `/api` unless `http.basePath` in `maximus()` says otherwise. The
OpenAPI document's server URL and OAuth discovery include it. Transports, plain routes and mounts stay
at their absolute paths, `/mcp` and not `/api/mcp`. A base path is absolute, without a trailing slash or
dot segments.

The health check answers `GET` alone, without a token, with `{ status: 'ok', service, version }`, and
probes no dependency. `http.healthPath` moves it to an absolute path of your choice; without it,
`createWorker` serves it at `/health` below the base path. A project's is `/health`, at the root, unless
`http.healthPath` in `maximus()` says otherwise.

When a proxy in front of the Worker removes a prefix itself, leave `basePath` unset and set `origin` to
the public base URL, prefix included, so the documents and discovery advertise the URLs callers use.

## Static assets

`assets` serves a single-page application, or another build, from a
[Workers static assets](https://developers.cloudflare.com/workers/static-assets/) binding, with each
path's answer decided by the Worker. A project with `index.html` at its root gets this policy from
`maximus()`; see [Web apps](web-apps.md). In a Worker composed by hand:

```ts
assets: {
  binding: 'ASSETS',
  pages: { paths: ['/', '/settings'], patterns: [/^\/notes\/[0-9a-f-]{36}$/u] },
  files: ['/manifest.webmanifest', '/sw.js'],
  immutablePrefixes: ['/assets/'],
  headers: { 'content-security-policy': "default-src 'self'" },
},
```

| Path                               | Answered with                                       | `cache-control`                       |
| ---------------------------------- | --------------------------------------------------- | ------------------------------------- |
| `pages.paths` and `pages.patterns` | The shell, `pages.shell` (`/index.html` by default) | `no-store`                            |
| `files`                            | The file itself                                     | `no-cache`                            |
| Below `immutablePrefixes`          | The file itself                                     | `public, max-age=31536000, immutable` |
| Anything else                      | The `404` failure `NOT_FOUND`                       | `private, no-store`                   |

- A path below an immutable prefix is served as an immutable file only when it is plain: an encoded
  character or a dot segment there answers `404`. An answer of the binding other than `200` keeps its
  status and is `no-store`.
- Only `GET` and `HEAD` are served; another method answers `405` with `allow: GET, HEAD`. The binding
  receives the path and the method alone: no credentials, query or request headers.
- `headers`, or a function of the request and the environment that returns them, adds browser policy to
  every asset; it cannot change `content-type` or `cache-control`, and `x-content-type-options: nosniff`
  is always set.
- `development: true` forwards any other `GET` or `HEAD` to the binding as it came, for a Vite dev server
  that stands behind it. Pass `import.meta.env.DEV`, which every build sets to `false`: a deployed Worker
  never forwards unknown paths.
- Page patterns may not use the global or sticky flags, and an immutable prefix cannot be `/`. `assets`
  and `http.fallback` cannot both be set, since both would answer unmatched paths:
  `Worker assets and an HTTP fallback cannot both own unmatched paths.`

Configure the Worker's static assets so the Worker decides every answer: `htmlHandling: 'none'`,
`notFoundHandling: 'none'` and `runWorkerFirst: true`, as `maximus()` does for a web app.

## Entrypoints and Durable Objects

`worker.entrypoint` serves the operations that declare `rpc` to other Workers; export it under the name
their Service Bindings give as `exportName` (see [Worker RPC](worker-rpc.md)). `worker.service(Class)` and
`worker.durableObject(Class)` wrap classes of your own so their methods run inside the application's
diagnostics:

```ts
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';

class ReportsEntrypoint extends WorkerEntrypoint<Env> {
  async count(organizationId: string) {
    // …
  }
}

class Session extends DurableObject<Env> {
  // …
}

export const ReportsService = worker.service(ReportsEntrypoint);
export const SessionObject = worker.durableObject(Session);
```

A wrapped class keeps its methods, its type and its identity. Maximus does not check the arguments of
your own methods: check them where they enter, as any boundary does. Keep Durable Object class names and
migrations stable across releases, since renaming a class orphans its stored state. A project declares
its Durable Objects as files instead; see [Durable Objects](durable-objects.md).

## The route resolver

`createHttpRouteResolver(definitions)` exposes the router, for code that must choose something per route
before it runs, such as a database session:

```ts
import { createHttpRouteResolver } from '@arbol-ai/maximus';

const routes = createHttpRouteResolver(
  Object.entries(app.operations).map(([name, operation]) => ({ name, http: operation.http }))
);
const match = routes.match('GET', '/v1/notes/count');
// { definition, parameters }, or null
```

It matches as the API does, decoding each path segment before it matches it, and does nothing else: no
token, no input check. `routes.ownsPath(path)` says whether any route answers a path, whatever its
method. Paths are matched without the base path.

## Reserved paths

| Path                                                                                                                                                   | Owner                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `/`, `/health`, `/openapi.json`, `/openapi.yaml`, `/openapi.yml`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp` | The service's own answers, below the base path |
| `/v<n>/…`                                                                                                                                              | Operations, below the base path                |
| The health path, when `healthPath` moves it                                                                                                            | The health check                               |
| Each transport's path, `/mcp` for MCP                                                                                                                  | The transport                                  |
| Each key of `tokens.resources`                                                                                                                         | OAuth discovery                                |

Plain routes, mounts, transports and pages that collide with these, or with each other, are refused when
the Worker starts.
