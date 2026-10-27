# Project structure

Maximus is API first: each operation owns one contract, scope, effect and Result handler, shared by
HTTP/OpenAPI, MCP and native Worker RPC. The project layout adds filesystem discovery to that pipeline.

`maximus init my-service --name my-service --layout project` creates a Vite+ project with no `src/`
requirement. Existing service layouts and default-export route factories remain supported.

```text
maximus.config.ts          Application, authentication and Worker transport policy
errors.ts                  Optional error catalog; every handler's fail is typed by its codes
routes/v1/greeting.get.ts   One defineHandler per route and method: GET /api/v1/greeting
mcp/tools/summarize.ts     Optional MCP-only tools, named by their file
middleware/10-response.ts   Ordered HTTP request middleware
pages/index.ts             Optional public response at /
crons/daily.ts             Optional scheduled handler and cron expression
queues/notifications.ts    Optional physical queue consumer
email/help@example.com.ts  Optional exact-recipient email handler
durable-objects/session.ts Optional class, exported as Session
db/                       Application-owned schemas and migrations
src/                      Optional shared domain code; no framework entrypoints required
public/                   Assets, when explicitly configured
tests/                    Explicitly run tests; never discovered as routes
.maximus/                 Generated composition, ignored by Git
cloudflare.config.ts      Infrastructure; names .maximus/entry.ts as its entrypoint
vite.config.ts            maximusProject() before cloudflare()
```

## Configuration and routes

`maximus.config.ts` is a runtime-neutral module. Configure the application once:

```ts
import { defineErrors } from '@arbol-ai/maximus';
import { defineConfig } from '@arbol-ai/maximus/config';

export default defineConfig<Env>({
  name: 'notes',
  namespace: 'notes',
  title: 'Notes',
  version: '1.0.0',
  origin: 'https://notes.example.com',
  tokens: { issuer: 'https://identity.example.com/', audience: 'https://notes.example.com' },
  errors: defineErrors({}),
  rpc: { callers: [] },
  worker: { http: { basePath: '/api', healthPath: '/health' } },
});
```

For derived context, pass `{ application: maximus<Env>({...}).derive(...), worker: {...} }` instead.
The builder must not already declare operations. Do not import generated modules or route modules
into configuration: generated composition imports configuration, and the reverse would create a cycle.
Cloudflare resource bindings, triggers, migrations and secrets stay in `cloudflare.config.ts`.
The starter defines `#maximus/*` package imports for the generated modules, so route imports do not
change with directory depth. Relative imports remain supported.

A route is a file whose name gives its path and method, and whose default export is a `defineHandler`
declaration. `input` and `output` take a schema or the fields of a strict object; the handler receives one
object (`{ input, principal, env, fail, …context }`, with the context the base prepares) and returns its
output or `fail(code)`:

```ts
// routes/v1/tasks/[taskId]/complete.post.ts: POST /api/v1/tasks/{taskId}/complete
import { defineHandler, UuidSchema } from '@arbol-ai/maximus';

import { TaskSchema } from '../../../../src/tasks.ts';

export default defineHandler({
  description: 'Mark a task as done. Completing a done task changes nothing.',
  input: { taskId: UuidSchema },
  output: TaskSchema,
  failures: ['TASK_NOT_FOUND'],
  mcp: { name: 'complete_task', idempotent: true },
  handler: async ({ input, tasks, fail }) => {
    const task = await tasks.get(input.taskId);
    if (!task) {
      return fail('TASK_NOT_FOUND');
    }
    return task.done ? task : tasks.put({ ...task, done: true });
  },
});
```

What a route leaves out, binding derives:

| Field            | Default                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `operationId`    | The method and path in camelCase: `postV1TasksTaskIdComplete`. It also names the RPC method                                            |
| `effect`         | `read` for GET, `delete` for DELETE, `write` for the other methods                                                                     |
| `scope`          | `<namespace>:<resource>:read` for a read, `:write` otherwise; the resource is the first fixed segment after the version, in kebab-case |
| `title`          | The MCP tool's name as words (`Complete task`), else the method and path                                                               |
| `description`    | None; a route that is also an MCP tool must describe itself                                                                            |
| `mcp.idempotent` | As the HTTP method: true for GET, PUT and DELETE                                                                                       |

Declare any of them when the default is wrong: a POST search declares `effect: 'read'`, and so takes the
read scope. A path whose segments after the version are all parameters names no resource and must declare
its `scope`. `failures` lists the domain codes the route may answer; `fail` then accepts only those and the
standard failures, with the data each code declares. Each declaration is checked as a whole: the schemas
are strict objects, path parameters are required string fields of `input`, mutations never use GET, and a
field no route has is refused. `http` takes the byte body, header and attachment options; the path and
method belong to the filename.

`mcp/tools/<name>.ts` default-exports a `defineTool`: a tool only MCP serves, with no HTTP route. The file
`summarize-tasks.ts` is the tool `summarize_tasks` and the operation `summarizeTasks`. A tool states its
`description` and `effect`; its scope defaults to `<namespace>:<file>:read` or `:write` and it is
idempotent when it reads. When a route or a tool declares MCP, the generated Worker adds the MCP transport
unless the configuration already has one. MCP needs OAuth discovery: configure `tokens.issuer`, not an
application `bearer` scheme.

Handlers are typed through the global `MaximusRegister`, which `maximus prepare` writes in
`.maximus/register.d.ts`: its `base` gives every handler its context. A root `errors.ts` that
default-exports the error catalog adds `errors`, which types `failures` and `fail`; the application must
use that same catalog (`errors` in `maximus.config.ts`), which the generated base checks when the Worker
starts. Include `.maximus/*.ts` in `tsconfig.json`: TypeScript does not expand a bare `.maximus` entry.

`routes/v1/notes/index.get.ts` maps to `GET /v1/notes`; `routes/v1/notes/[noteId].delete.ts` maps to
`DELETE /v1/notes/{noteId}`. `(group)` directories organize files without adding URL segments. With the
starter's `/api` base, greeting is `/api/v1/greeting`. Catch-all operation routes are unsupported.
Versioned templates retain ownership and schema admission.

The forms of 7.3 and 7.4 keep working. A file without a method suffix exports `GET`, `POST`, `PUT`,
`PATCH` or `DELETE` declarations made with the generated `defineRoute` helper (`#maximus/routes`), each
naming its operation, or default-exports a route factory that receives its path. Such a file owns its
whole path: it cannot share it with suffixed files. Exports must be explicit; `export *` and mixing a
default route factory with method exports in one file are refused.

### Filename decisions

These mappings assume `worker.http.basePath: '/api'`. Filenames determine the URL and, with a suffix,
the method.

| Source                                                       | Export                         | HTTP registration or behavior                                         |
| ------------------------------------------------------------ | ------------------------------ | --------------------------------------------------------------------- |
| `routes/v1/greeting.get.ts`                                  | `defineHandler`                | `GET /api/v1/greeting`                                                |
| `routes/v1/notes/index.get.ts`, `index.post.ts`              | `defineHandler`                | `GET` and `POST /api/v1/notes`; `index` adds no segment               |
| `routes/v1/notes/[noteId].delete.ts`                         | `defineHandler`                | `DELETE /api/v1/notes/{noteId}`; `noteId` belongs in `input`          |
| `routes/v1/(staff)/reports.get.ts`                           | `defineHandler`                | `GET /api/v1/reports`; the group adds no URL segment or authorization |
| `routes/v2/notes.get.ts`                                     | `defineHandler`                | `GET /api/v2/notes`; versions are explicit directories                |
| `routes/v1/debug.get.dev.ts`                                 | `defineHandler`                | `GET /api/v1/debug` only in `development` mode                        |
| `routes/v1/status.get.prod.ts`                               | `defineHandler`                | `GET /api/v1/status` only in `production` mode                        |
| `routes/v1/greeting.ts`                                      | `GET`, `POST` (7.4)            | `GET` and `POST /api/v1/greeting`; the file owns the path             |
| `mcp/tools/summarize-tasks.ts`                               | `defineTool`                   | The MCP tool `summarize_tasks`; no HTTP route                         |
| `routes/v1/_schemas.ts`, `routes/_shared/`, `mcp/_shared.ts` | Any                            | Helpers; ignored by discovery                                         |
| `routes/v1/greeting.test.ts`, `routes/v1/greeting.spec.ts`   | Any                            | Test modules; ignored by discovery                                    |
| `routes/v1/greeting.d.ts`                                    | Types                          | Declaration file; ignored by discovery                                |
| `routes/greeting.get.ts`, `routes/v1/index.get.ts`           | `defineHandler`                | Rejected: an operation needs a resource below a version               |
| `routes/v1/[...rest].get.ts`, `routes/v1/[[id]].get.ts`      | `defineHandler`                | Rejected: no catch-all or optional segments                           |
| `pages/index.ts`                                             | Default response handler       | Public `GET /` and `HEAD /`, outside the API base                     |
| `middleware/10-response.ts`                                  | Default middleware declaration | Global policy; no route is registered                                 |

Use kebab-case for resource files, `[camelCase]` for contract parameters, lowercase method suffixes and
zero-padded numeric prefixes for middleware order. Segment casing is preserved. Route groups only
organize source: putting a file in `(staff)` does not make it private. Declare its scope and visibility.

A suffixed file default-exports its declaration and nothing else: keep schemas and helpers unexported,
in an ignored helper module or in `src/`. Type-only exports are allowed. `get.ts` names a resource
literally called `get`; only a suffix after another name selects a method. `HEAD` and `OPTIONS` are not
operation methods; HTTP transport handling remains owned by the native pipeline.

Each method of a path has one owner. Two suffixed files for the same method and path are an error, as
are a base file and a matching `.dev`/`.prod` file: a mode suffix selects a file, it does not override
one. Modes other than `development` and `production` include unsuffixed modules only.

## Middleware

Files in `middleware/` run globally in ascending filename order. Numeric prefixes make order explicit.
The phase is explicit so HTTP admission and transport-independent business policy retain their owners.

```ts
// middleware/10-response.ts
import { defineMiddleware } from '@arbol-ai/maximus/config';

export default defineMiddleware<Env>(async (_request, _env, _context, proceed) => {
  const response = await proceed();
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set('referrer-policy', 'no-referrer');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
});
```

`defineMiddleware` (also named `defineRequestMiddleware`) wraps HTTP after configured origin admission and before routing/token admission.
It sees a bodyless request metadata copy, bindings and native request context, never an authenticated principal.
Header changes affect only that copy; native token admission and bounded body reading keep the original request. Calling
`proceed()` enters the unchanged HTTP pipeline; it may run only once before the middleware settles. Errors and response security
headers remain inside native handling. Preserve WebSocket 101 responses and response streams.
Configuration's `worker.http.middleware` runs before discovered request middleware.

For policy that runs after authentication, scope checks and context preparation on HTTP, MCP and RPC:

```ts
import { defineOperationMiddleware } from '@arbol-ai/maximus/config';
import type { ProjectContext } from '@arbol-ai/maximus/config';

import type config from '../maximus.config';

export default defineOperationMiddleware<ProjectContext<typeof config>>(async (context, proceed) => {
  // context.principal is verified; scope every tenant operation by its organizationId.
  return proceed();
});
```

Bare middleware functions from the 7.3 layout keep their operation phase. Middleware may import
configuration types, but must not import the generated base or routes at runtime. Configured base
middleware runs before discovered operation middleware; route factories capture that combined base. Generated composition rejects any factory that omits
that middleware prefix, including a helper accidentally created from the pre-middleware config base.

### `next()` / `proceed()` and ordering

`next` and `proceed` are names for the same callback argument; Maximus does not export a separate
`next` function. The examples call it `proceed` to make continuation explicit. Always await or return
the continuation. Work before it runs on the way in; work after it runs on the way out.

```text
HTTP origin admission
  configured worker.http.middleware
    middleware/10-response.ts             request phase: before proceed()
      middleware/20-request-policy.ts     request phase: before proceed()
        native routing, token, scope and input admission
          configured/derived operation context
            configured base.use(...) middleware
              middleware/30-business-policy.ts   operation phase: before proceed()
                operation handler -> Result
              operation phase: after proceed()
            native output/error validation
      request phase: after proceed()
    request phase: after proceed()
native HTTP response/security headers
```

Filenames are sorted by code units, including nested directory names, independently inside each
phase. `01-business.ts` cannot move operation middleware ahead of authentication. Folder middleware
is global: `middleware/v1/` does not scope it to `/v1`. For a particular resource, use a derived base
with `.use(...)` and `createRoute(derivedBase)`; derive it from `#maximus/base` so global policy stays
in the chain. Do not import that generated base back into a middleware module.

| Behavior                  | Request middleware                                                   | Operation middleware                                            |
| ------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| Arguments                 | Bodyless request copy, bindings, request context, continuation       | Verified/derived operation context, continuation                |
| Continuation result       | `Promise<Response>`                                                  | `Promise<Result<unknown, Failure>>`                             |
| Applies to                | HTTP requests entering the configured HTTP transport                 | HTTP, MCP and RPC operations                                    |
| Before authentication     | Yes; no trusted principal is available                               | No; admission and context preparation have completed            |
| Short circuit             | Return a native `Response` without calling `proceed()`               | Return a declared error Result; native validation still applies |
| Repeat continuation       | Rejected; also rejected after its wrapper has settled                | Rejected by the existing execution chain                        |
| Modify request body/token | The copy has no body; changing its headers does not change admission | Do not replace trusted identity or bypass schema admission      |

An HTTP short circuit does not execute a protected operation. Use the operation phase for tenant
policy or anything that must protect MCP and RPC as well. Read tenant identity from the verified
context, never from a path, header or request body. Returning an error uses the application's declared
failures; throwing follows the native unexpected-error path. Do not keep a continuation for later
background work. Use the native background context for independent work instead.

## Reconciliation and compatibility

`maximus prepare` generates `.maximus/base.ts`, `routes.ts`, `register.d.ts`, `app.ts`, `middleware.ts`, `worker.ts` and the stable `entry.ts`.
The generated Worker exports its default handler, typed `Service` RPC entry and discovered Durable
Objects. No application module or configuration executes on the build host: Oxc reads route exports,
and generated code uses literal imports and chained builder calls without widening operation types.

`maximusProject()` runs preparation during Vite configuration and every build. Development reconciles
added, removed and changed files, including changes to method exports inside a file. Build watch
tracks discovered modules and existing convention directories; restart it after creating a convention
directory that was absent when watch started.
Unchanged generated content is not rewritten. Failed discovery does not replace the prior graph;
builds fail and development reports an error. A new build always discovers the current mode afresh.
Deleting a route or method removes it from the generated composition. This reconciles source modules,
not cloud infrastructure; builds never provision or delete stores, run SQL or change credentials.

Use `maximus prepare --mode development` for development editor types; the default is production.
`bun run verify` runs preparation, Cloudflare types, TypeScript, lint/format and Vite+ build. A standalone
`vp build` reconciles and bundles; TypeScript and lint remain the explicit `verify` checks.

Without root configuration, Maximus continues to use `src/application.ts`'s `base` and
`src/worker.ts`'s `options`. Existing default-export factories still receive the inferred path and
return a builder. They can coexist with named method modules in other files. For gradual migration,
keep old factories and re-export their shared base from `.maximus/base` in `src/application.ts` after
moving configuration to the root. Root configuration itself must not import that compatibility bridge.
Projects with multiple root configuration files are rejected rather than picking one silently.

### Generated files and the build boundary

| Generated module         | Responsibility                                                             |
| ------------------------ | -------------------------------------------------------------------------- |
| `.maximus/middleware.ts` | Import discovered modules and separate request/operation phases            |
| `.maximus/base.ts`       | Attach operation policy to the configured base; preserve its derived types |
| `.maximus/routes.ts`     | Export the project's typed `defineRoute` helper, for 7.4 route modules     |
| `.maximus/register.d.ts` | Register the base and error catalog that type every handler                |
| `.maximus/app.ts`        | Bind every discovered route and tool and build the typed manifest          |
| `.maximus/worker.ts`     | Compose HTTP/MCP/RPC, pages, events and Durable Object exports             |
| `.maximus/entry.ts`      | Stable Cloudflare entry that re-exports the generated Worker               |

The generator validates the source graph before writing files, then writes dependencies before their
consumers. It replaces changed files individually and leaves identical content untouched. Generated
files are disposable and ignored by Git. Never hand-edit them or import generated modules from root
configuration. A clean checkout regenerates them through installation's `prepare` lifecycle, an
explicit `maximus prepare`, or the Vite plugin before a build. Installation with scripts disabled
requires one of those explicit preparation paths before editor/type checking.

Adding a method changes the generated manifest at the next reconciliation. Removing a file removes
its imports and mounts. Changing the root configuration filename or Durable Object exports restarts
the development server so Cloudflare can refresh its entry exports. A normal operation-body change
uses Vite's module update path. Production deployment consumes the completed build artifact; it never
scans the source filesystem at request time.

## Tests and validation

Tests do not register routes, apply migrations or run as part of `maximus prepare`. Keep application
tests under `tests/`, or colocate `*.test.ts` / `*.spec.ts` with a route. Helpers and fixtures within a
convention directory must use an ignored `_` path. Merely putting `fixture.ts` next to a route would
make it a candidate route module.

Suggested application organization, when a test runner is explicitly added:

```text
tests/
  routes/greeting.test.ts       Input/output contracts and operation behavior
  middleware/response.test.ts   Request wrappers and continuation behavior
  integration/http.test.ts      Local Worker admission and actual HTTP responses
  _fixtures/                   Synthetic, non-production fixtures
```

The project starter does not install an application test suite or invent a passing test command.
Its `bun run verify` performs preparation, Cloudflare type generation, TypeScript, lint/format and
the production build. Its automatic deployment workflow runs those checks. Tests require a separate
human request and configured runner; a successful build is not evidence that tests passed.

The framework already owns test sources under `packages/maximus/tests/`. The relevant regression
matrix for this feature is:

| Area                    | Cases to cover                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| Discovery               | Version/index/group/parameter mapping, ignored files, modes, collisions and symlinks                            |
| Export parsing          | Named verbs, explicit re-exports, type-only exports, malformed modules, forbidden wildcard/mixed exports        |
| Reconciliation          | Clean generation, identical rebuilds, method edits, file additions/removals, failed discovery and mode switches |
| Request middleware      | Ordering, response wrapping, short circuits, single continuation, body ownership and unchanged token headers    |
| Operation middleware    | Verified context, order, schema/error validation, HTTP/MCP/RPC parity and missing global-policy rejection       |
| Compatibility and types | Legacy factories, derived context, literal operation names, typed RPC and a project with no `src/`              |

Compile-only controls live in `packages/maximus/tests/project-types.ts`; generator test source lives
in `packages/maximus/tests/tooling/project.test.ts`. The full matrix above describes coverage to
establish, not a claim that every row has an executed test. When a human requests the relevant suite,
the framework commands are:

```bash
# Framework repository only; explicit test authorization required.
bun run test
bun run test:integration
```

Use the root `bun run verify` for the framework's builds, workspace types, lint and format without
running a test suite. The manual GitHub verification workflow also exposes an explicit `run_tests`
input; ordinary pushes do not enable it.

## Pages and static files

Pages default-export an `HttpRoute<Env>` returning a native `Response`; `index.ts` is the directory's
root. They serve GET and HEAD at fixed paths. Other methods return 405. The project runtime rejects
pages that claim API, discovery or protocol paths. Native request ids, errors and security headers
still apply. A page owns any authentication it needs; tenant operations belong in `routes/`.

This is response rendering, not a UI framework: React/Vue/Svelte/Solid layouts, loaders, Markdown and
dynamic page routes are not supplied. Choose a rendering adapter explicitly when the product needs
one. `.tsx`/`.jsx` modules use the application's Vite JSX configuration.

`public/` is a convention for application assets, not implicit publication. Configure an ASSETS
binding and `options.assets` with admitted files or SPA paths as described in
[Worker composition](worker-composition.md#static-assets). Discovered pages take precedence over the
assets fallback. Database migrations likewise remain explicit; discovery never runs SQL.

## Scheduled work, queues and email

A cron module exports `cron` and defaults to a native `ExportedHandlerScheduledHandler<Env>`:

```ts
export const cron = '0 8 * * *';
const daily: ExportedHandlerScheduledHandler<Env> = async (controller, env, context) => {
  await env.JOBS.send({ scheduledAt: controller.scheduledTime });
};
export default daily;
```

Declare the matching cron trigger in `cloudflare.config.ts`; discovery never provisions it.
Modules sharing a schedule all run and their failures propagate. Unmatched schedules use an explicit
`options.handlers.scheduled` fallback or fail.

`queues/<physical-queue-name>.ts` defaults to a native queue handler. Declare the queue consumer and
its retry/dead-letter policy in Cloudflare. Unknown queues use an explicit fallback or throw, so a
batch is never silently acknowledged. Handler authors own per-message acknowledgement and retries.

`email/<full-recipient>.ts` defaults to a native email handler. `email/_default.ts` handles unmatched
recipients; otherwise an explicit `options.handlers.email` fallback runs, or the message is rejected.
Email Routing configuration remains separate. Queue and email modules must be top-level files.

## Durable Objects

`durable-objects/session-store.ts` defaults to a class extending Cloudflare's `DurableObject<Env>`.
The generated Worker exports it as `SessionStore`, wrapped in the existing diagnostics adapter.
Declare bindings and migrations with that exact class name in `cloudflare.config.ts`. Never rename
a deployed file/class casually: Cloudflare storage identity and migrations belong to the application.
`Service` is reserved for the generated native RPC entrypoint.

## Discovery boundaries

Modules may use `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` or `.cjs`. Dotfiles, helper paths
starting with `_`, declaration files and `.test`/`.spec` files are excluded; `email/_default` is the
sole underscore exception. `.dev` and `.prod` suffixes select only the matching Vite mode. A base
file and a mode-specific file must not claim the same route. Symlinks in convention directories are
refused. No filesystem access or runtime source compilation enters the Worker bundle.

`bun run verify` in the project starter runs types, lint/format checks and a build. Its GitHub workflow
uses those checks on pull requests and deploys `main` with repository/organization Cloudflare secrets.
Tests are a separate, explicitly requested action. The starter's public home page is usable immediately;
production API tokens fail closed until the application's token policy is configured.
