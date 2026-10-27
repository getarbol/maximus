# Upgrading to 8.0

This guide moves a 7.x service to Maximus 8.0. In 8.0 a service is a project configured by one file,
`vite.config.ts`, whose routes are files: the service layout of 7.0 to 7.2 (`src/app.ts`, `src/index.ts`
and `cloudflare.config.ts`) and the project layout of 7.3 and 7.4 (`maximus.config.ts`, route modules that
export `GET` or a factory, `defineRoute`) are gone. What callers see does not change unless a section
below says so: the HTTP envelope, the OpenAPI document, MCP and RPC keep their shapes, and the operation
names and scopes clients depend on can be kept exactly.

Work on a branch, and save the OpenAPI document your service serves today (`/openapi.json` or
`/api/openapi.json`) before you start: comparing it with the one 8.0 serves is the quickest way to prove
that no operation, scope or tool changed by accident.

## Update the toolchain and packages

8.0 builds with [Vite+](https://viteplus.dev) (`vp`), TypeScript 7 and Cloudflare's `cf` CLI, on Bun 1.4 and
Node.js 22.18 or later. Install the packages a project needs:

```sh
bun add @arbol-ai/maximus@^8
bun add -d @arbol-ai/vite-plugin@^8 vite-plus@1.4.0 vite@npm:@voidzero-dev/vite-plus-core@1.4.0 \
  typescript@7.0.2 cf@1.0.0-beta.23 @cloudflare/workers-types @types/node oxlint oxfmt ultracite
```

The fastest way to see every file 8.0 expects is a fresh project beside yours: `bun create maximus
scratch --yes` writes the scripts, `tsconfig.json`, `.gitignore`, CI workflow and agent guides that the
rest of this guide refers to. Copy the scripts and the `overrides` from its `package.json`: `dev` is
`vp dev`, `test` is `vp test run`, `typecheck` runs `maximus prepare` before `tsc`, and `deploy` verifies
the project before `cf deploy --prebuilt --mode production`.

## Move the configuration into vite.config.ts

`maximus()` from `@arbol-ai/vite-plugin` states the application and its Worker. Each 7.x setting has one
place in it, or in a root module when it is code rather than configuration:

| 7.x                                                                         | 8.0                                                          |
| --------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `name`, `namespace`, `title`, `version`                                     | The same options; by default, the package's name and version |
| `origin`                                                                    | `origin`                                                     |
| `tokens.issuer`, `audience`, `jwksUri`, `algorithms`, `claims`, `scheme`, … | `tokens`; `audience` defaults to the origin                  |
| `tokens.development`                                                        | `tokens.development`, `DEVELOPMENT_TOKEN` by default         |
| `tokens.resolve`, `resources`, `resourceMetadataUrl`                        | `auth.ts`: `export default defineAuth({ resolve, … })`       |
| `errors: defineErrors({ … })`                                               | `errors.ts`: `export default defineErrors({ … })`            |
| `telemetry: { enabled, observers, traceId }`                                | `telemetry.ts`: `export default defineTelemetry({ … })`      |
| `rpc.callers`, `maxBodyBytes`, `maxOutputBytes`, `rateLimit`                | The same options                                             |
| `worker.http.basePath`, `healthPath` (`maximus.config.ts`)                  | `http: { basePath, healthPath }`, `/api` and `/health`       |
| `mcp: { instructions, guides, skills }`                                     | Markdown files in `mcp/`; see [MCP](#mcp)                    |
| `cloudflare.config.ts`: `compatibilityDate`, `env`, `triggers`, `routes`, … | The same names, directly in `maximus()`                      |

A 7.x service's two configuration files become one:

```ts
// vite.config.ts
import { maximus } from '@arbol-ai/vite-plugin';
import { bindings } from 'cf/config';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [
    maximus({
      origin: 'https://notes.example.com',
      tokens: { issuer: 'https://auth.example.com/' },
      rpc: { callers: ['billing'] },
      env: { NOTES: bindings.kv({ id: '0f2a…' }) },
      compatibilityDate: '2026-10-27',
    }),
  ],
});
```

Leave out what Maximus now owns. It sets the Worker's entry, adds `nodejs_compat`, turns off preview URLs,
sets the observability defaults your `cloudflare.config.ts` probably repeated, and declares the
development token's binding under `vp dev` alone, so the `DEVELOPMENT_TOKEN: mode === 'development' &&
bindings.secret()` line goes away. A `workers.dev` origin is served there, and any other origin becomes the
Worker's custom domain unless `domains` or a fetch trigger routes it. [Configuration](reference/configuration.md)
lists every option.

Then delete `maximus.config.ts` and `cloudflare.config.ts`, which the plugin refuses to find beside it,
the Worker entry (`src/index.ts` or `src/worker.ts`) and any `vitest.config.ts`: `vp test` reads
`vite.config.ts`. Add `.maximus/` to `.gitignore`; it is generated on every `vp dev`, `vp build` and
`vp test`.

## Turn operations into route files

Each operation with an HTTP route becomes a file of `routes/` named by its path and method, whose default
export is `defineHandler(handler, contract)`. `bunx maximus gen route get '/v1/notes/{noteId}'` writes
the file where it belongs. A builder operation:

```ts
// 7.x
base.operation(
  'getNote',
  {
    scope: 'notes:notes:read',
    effect: 'read',
    title: 'Get a note',
    description: 'Read one note by its identifier.',
    input: t.Object({ noteId: UuidSchema }, { additionalProperties: false }),
    output: NoteSchema,
    failures: ['NOTE_NOT_FOUND'],
    http: { method: 'GET', path: '/v1/notes/{noteId}' },
    mcp: { name: 'get_note', idempotent: true },
  },
  async ({ notes }, input) => {
    const note = await notes.get(input.noteId);
    return note ? ok(note) : err(errors.noteNotFound.create());
  }
);
```

becomes `routes/v1/notes/[noteId].get.ts`:

```ts
// 8.0
import { defineHandler, UuidSchema } from '@arbol-ai/maximus';

import { NoteSchema } from '../../../src/notes.ts';

export default defineHandler(
  async ({ input, notes, fail }) => (await notes.get(input.noteId)) ?? fail('NOTE_NOT_FOUND'),
  {
    operationId: 'getNote',
    title: 'Get a note',
    description: 'Read one note by its identifier.',
    input: { noteId: UuidSchema },
    output: NoteSchema,
    failures: ['NOTE_NOT_FOUND'],
    mcp: { name: 'get_note' },
  }
);
```

What changes:

- The handler receives one object, `{ input, principal, env, fail, …context }`, and answers its output or
  `fail(code)` instead of a `Result`. `fail` is typed by the contract's `failures` and their data.
- The path and method come from the file's name: `[noteId]` is a path parameter, and `index.post.ts`
  answers the folder's own path. Write one file per method.
- `input` and `output` take a schema or the fields of a strict object.
- What a contract leaves out is derived from the method and path: the operation's name
  (`getV1NotesNoteId`), its effect (`GET` reads, `DELETE` deletes, the others write), its scope
  (`notes:notes:read`) and its title. **Keep every name and scope your clients and tokens depend on** by
  declaring `operationId` and `scope` where the derived ones differ: the operation's name is its OpenAPI
  `operationId` and its RPC method, and a token holds scopes by their exact text.
- A route's tool is idempotent by default for `GET`, `PUT` and `DELETE`, and a tool of `mcp/tools/` when it
  reads; `mcp: { name, idempotent, openWorld }` states otherwise.

A 7.3 or 7.4 route module that exports `GET`, a route factory or `defineRoute` becomes the same kind of
file, one per method. An operation that has an MCP tool but no HTTP route becomes a file of `mcp/tools/`
with `defineTool(handler, contract)`, named by its file. [Routes](guides/routes.md) covers every contract
field.

## Context, errors, authentication and middleware

- **`.derive()`** becomes `context.ts`, whose default export is `defineContext(({ env, principal }) =>
  …)`: what it returns joins every handler's arguments, and `fail(code)` answers the call. A failure it
  answers is held to the route's declared `failures`, as a handler's is.
- **The error catalog** moves to `errors.ts`, `export default defineErrors({ … })`, which types every
  handler's `fail`.
- **A token resolver** moves to `auth.ts`, `export default defineAuth({ resolve })`. `defineAuth` takes
  `resolve`, `resources` and `resourceMetadataUrl` only; the issuer, audience and every other token setting
  stay in `vite.config.ts`.
- **Request middleware** is a file of `middleware/` whose default export is `defineMiddleware(…)`, run in
  filename order before token admission. A module that exported a bare function, and the
  `defineRequestMiddleware` alias, are gone.
- **`.use()`** becomes operation middleware: a file of `middleware/` whose default export is
  `defineOperationMiddleware(…)`, typed with `PreparedContext<typeof context>`. It runs after admission on
  HTTP, MCP and RPC alike.

See [Context and middleware](guides/middleware-and-context.md) and
[Authentication and scopes](guides/authentication-and-scopes.md).

## Pages, webhooks and events

What a 7.x Worker received besides its operations becomes files of the project:

| 7.x                                                          | 8.0                                                                               |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| A plain route, `routes: { '/webhooks/payments': receive }`   | `pages/webhooks/payments.post.ts`, a page named for the method it answers         |
| A public page at a fixed path                                | `pages/<path>.ts`, which answers `GET` and `HEAD`                                 |
| `handlers.scheduled`, `queue` and `email`                    | `crons/<name>.ts`, `queues/<queue>.ts` and `email/<recipient>.ts`                 |
| A Durable Object class the Worker exports                    | `durable-objects/<name>.ts`                                                       |
| `http`'s `mounts`, `origins`, `before` and `aroundOperation` | A Worker composed by hand; see [Worker composition](guides/worker-composition.md) |

A page answers only the methods its files name and refuses any other with `405` before it runs, so a
webhook moved to `pages/` drops its own method check; it still verifies the delivery's signature on its
exact bytes. See [Project structure](guides/project-structure.md#receive-a-webhook) and
[Background work](guides/background-work.md).

## MCP

The MCP server is described in Markdown files the Worker serves:

| 7.x (`mcp` in code)     | 8.0                                                             |
| ----------------------- | --------------------------------------------------------------- |
| `instructions`          | `mcp/instructions.md`                                           |
| `guides: [{ name, … }]` | `mcp/guides/<name>.md`, titled by its first heading             |
| `skills: [{ name, … }]` | `mcp/skills/<name>.md`, with its description in the frontmatter |

The Worker serves `/mcp` when a route or tool declares MCP or any of these files exists. See
[MCP](guides/mcp.md).

## Development and tests

- `bun run dev` runs `vp dev` instead of `cf dev`. The development token stays in `.dev.vars` as
  `DEVELOPMENT_TOKEN`, accepted from `localhost` alone, and no build ever carries it.
- Tests run with `vp test`. A test calls the API as the Worker serves it through `handler` from
  `#maximus/http`, which `.maximus/http.ts` generates, with an `env` of its own: see
  [Testing](guides/testing.md).
- The RPC entrypoint is exported as `Service`. A calling Worker's binding names it:
  `bindings.worker({ worker: 'example-notes', exportName: 'Service', props: { caller: 'billing' } })`.

## The typed HTTP client

`@arbol-ai/maximus/client` and `createClient` are removed. Call a service over HTTP with `fetch` and the
caller's token, typing each call with `Static` of the route's schemas, or, between Workers of one account,
over native RPC (see [Worker RPC](guides/worker-rpc.md)).

## Behavior that changed

These changes reach a service even when its code compiles as it is. Review each one.

A service fails when it starts, with a `TypeError` that names the rule, when it has:

- under `tokens.scheme` `oauth+bearer`, an operation that does not name its `actorKinds`;
- a schema reference (TypeBox `Ref` or `Recursive`) that names no single definition;
- an application `name` that is not a lowercase kebab-case word of 2 to 64 characters, or an operation
  name over 100 characters;
- an error code that is not uppercase words joined by underscores, such as `RECORD_NOT_FOUND`;
- a `DELETE` route that declares `effect: 'read'`;
- a `telemetry` switch that is neither a boolean nor a function, or an observer whose callbacks are not
  functions, which only code TypeScript does not check can give;
- a record whose keys follow a pattern (`t.Record(t.String({ pattern }), …)`) without
  `additionalProperties: false`, which let a key outside the pattern through with any value;
- MCP guide or skill names that collide with each other or with the OpenAPI document's resources.

Each of these used to pass and fail later: the first request for the OpenAPI document answered 500, or
analytics dropped every event of the service without a word.

Calls:

- A domain failure from the context, a derive or middleware that the operation does not declare is
  answered as `INTERNAL_ERROR`, as one from the handler always was.
- An MCP JSON-RPC batch, which only 2025-03-26 clients send, is admitted whole: every message passes the
  rate limit before any of them runs, and a batch over the limit answers `429` with none of it run.
- Input with an own `__proto__` key, at any depth, or a query field named `__proto__`, is refused as
  `INVALID_INPUT`. An exception other than a schema mismatch inside an input codec answers
  `INTERNAL_ERROR` instead of `INVALID_INPUT`.
- The router decodes every path segment before it matches one, so an encoded fixed segment reaches its
  own route.
- An operation's JSON body sent with another `content-type` is refused with `415` and
  `UNSUPPORTED_MEDIA_TYPE` before any of it is read.
- A telemetry switch (`telemetry.enabled`) that throws turns telemetry off for the call, and the call
  still answers.
- `analytics()` records a pseudonym of each actor unless `actor: 'id'` asks for the id.

Libraries and entries:

- The webhook verifiers throw a `TypeError` when their secret is missing or empty. `readWebhookBody` is
  removed: read the raw body with `readBodyText` or `readBodyBytes` and a byte limit, then verify it.
- `withTenantTransaction` refuses an empty isolation level and an organization id that is not a string,
  before it checks a connection out.
- Static assets, a web app's build or `createWorker`'s `assets`, answer an immutable asset only for a plain
  path: an encoded slash, an encoded character or a dot segment there is a 404.
- `sameSchema` is removed, and so is the `ExecutionSink` type of `@arbol-ai/maximus/analytics`.
- A custom HTTP transport receives `admitCarried`, `refused` and `body` in its `TransportContext`, where it
  received `admitRequest` and `bodyBytes`.

The contract:

- The OpenAPI document and the MCP tool listing publish an input field that has a default as optional,
  since decoding fills it in. A `DELETE`'s request body is required only when its input requires a field.
- A list query parameter is published with `style: form` and `explode: false`, the `tags=a,b` form the API
  reads, so a generated client stops repeating the key.
- The API's index names the MCP endpoint whenever the Worker serves MCP.

The Worker:

- Builds are minified, the MCP SDK loads on the first MCP request, and `/openapi.yaml` is written without
  the `yaml` package, which is no longer a dependency of `@arbol-ai/maximus`.

The CLI:

- `maximus init` creates the 8.0 project only; `--layout` is gone. `maximus gen route`, `maximus gen
  tool`, `maximus skills` and `maximus prepare` are new, and every command prints a sentence, or JSON with
  `--json`. `bun create maximus` creates a project from a terminal. See [CLI](reference/cli.md).

## Check the upgrade

1. `bun run verify` passes: types, lint and format, tests and the build.
2. The OpenAPI document `vp dev` serves at `/api/openapi.json` lists the same `operationId`s, paths,
   scopes and `x-mcp-tool` names as the one you saved, or differs only where you meant it to.
3. An MCP client lists the same tools, and a Worker that calls this one over RPC still type-checks against
   its contract.
4. Deploy to a staging Worker first, and call it with a real access token before you deploy production.
