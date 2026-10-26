# Project structure

`maximus init my-service --name my-service --layout project` creates a backend with optional
file conventions. Both layouts use Vite+ by default. The default `service` layout remains available for explicit composition.
The project layout adds discovery without another HTTP router, token system or resource provisioner.

```text
routes/v1/greeting.ts       Authenticated operation factory
pages/index.ts             Public response at /
middleware/01-policy.ts    Optional operation middleware
crons/daily.ts             Optional scheduled handler and cron expression
queues/notifications.ts    Optional consumer for the notifications queue
email/help@example.com.ts  Optional handler for an exact recipient
durable-objects/session.ts Optional class, exported as Session
db/                       Application-owned schemas and migrations
src/application.ts        Configuration and the shared base builder
src/worker.ts             Explicit transports, HTTP policy and assets
src/index.ts              Re-exports the generated Worker
public/                   Assets, when explicitly configured
.maximus/                 Generated static imports, ignored by Git
cloudflare.config.ts      Cloudflare bindings, triggers, exports and migrations
vite.config.ts            maximusProject() before cloudflare()
```

Every convention directory is optional. The starter creates only the greeting and the home page.
`maximus prepare` generates imports without evaluating application code. The Vite plugin calls it
before builds and development, and discovers added/removed modules during development. Use
`maximus prepare --mode development` for development-only editor types; the default is production.
Generated composition uses literal imports and chained builder calls, retaining client and RPC types.

## Routes

A route file default-exports a factory that receives its path and returns a builder derived from
the application's shared `base`. It can declare several methods for that path. Each operation still
declares its name, scope, effect, schemas and transports explicitly:

```ts
import { EmptyInputSchema, ok, t } from '@arbol-ai/maximus';

import { base } from '../../src/application';

export default function greeting(path: string) {
  return base.operation(
    'getGreeting',
    {
      title: 'Get a greeting',
      description: 'Return a greeting to an authenticated caller.',
      scope: 'my-service:greeting:read',
      effect: 'read',
      input: EmptyInputSchema,
      output: t.Object({ message: t.String() }, { additionalProperties: false }),
      http: { method: 'GET', path },
    },
    () => Promise.resolve(ok({ message: 'Hello World' }))
  );
}
```

`routes/v1/notes/index.ts` receives `/v1/notes`; `routes/v1/notes/[noteId].ts` receives
`/v1/notes/{noteId}`. Declare `noteId` in its input schema as usual. `(group)` directories organize
files without adding a path segment. Duplicate paths, conflicting methods, invalid scopes and
ambiguous parameters are rejected by discovery or the existing builder. Catch-all operation routes
are unsupported: explicit versioned templates keep ownership and schema admission unambiguous.

The starter mounts the API at `/api`, so the greeting is `/api/v1/greeting`. Middleware under
`middleware/` default-exports `OperationMiddleware<Invocation<Env>>`; files run in ascending filename
order, after authorization, on HTTP, MCP and RPC. Use numeric prefixes for explicit order. Middleware
must import application types only, not `base`, to avoid a cycle while the base is being built.

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
