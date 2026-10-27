# The project

## vite.config.ts

The only configuration. `maximus()` states the application and the Worker that serves it, with Cloudflare's
own names for the Worker's settings:

```ts
import { maximus } from '@arbol-ai/vite-plugin';
import { bindings } from 'cf/config';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [
    maximus({
      origin: 'https://notes.example.com',
      tokens: { issuer: 'https://auth.example.com/' },
      compatibilityDate: '2026-10-27',
      env: { NOTES: bindings.kv() },
    }),
  ],
});
```

| Option                           | Meaning, and default                                                                                                                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `origin`                         | Required. The public HTTPS URL that OpenAPI, MCP resources and OAuth discovery advertise, and the default token audience. A `workers.dev` origin is served there; any other host becomes the Worker's custom domain unless `domains` or a fetch trigger route it.     |
| `tokens`                         | `issuer`, the OAuth authorization server; `audience`, the origin by default; `jwksUri`, `algorithms`, `claims`, `scheme`, `authorizationEndpoint`, `tokenEndpoint`; `development`, the development token's binding, `DEVELOPMENT_TOKEN` by default, `false` for none. |
| `name`                           | The Worker's name, the MCP server's and the scopes' prefix: lowercase letters, digits and single hyphens. By default, the package's name without its scope.                                                                                                           |
| `namespace`, `title`, `version`  | The scopes' prefix (the name), the human name (the name), the version `/health` reports (the package's).                                                                                                                                                              |
| `rpc`                            | `{ callers: ['billing'] }`: the deployments allowed to call RPC methods, by the `caller` their binding's props name. None by default.                                                                                                                                 |
| `http`                           | `{ basePath, healthPath }`: `/api` and `/health` by default.                                                                                                                                                                                                          |
| `maxBodyBytes`, `maxOutputBytes` | The limits of every operation that sets none: 32 KiB and 256 KiB.                                                                                                                                                                                                     |
| `rateLimit`                      | `{ binding, retryAfter }`: a rate limiting binding every HTTP and MCP call passes, per organization and actor.                                                                                                                                                        |
| `env`                            | The Worker's bindings, from `cf/config`'s `bindings`.                                                                                                                                                                                                                 |
| `webApp`                         | `{ headers }` for a web app's pages and files.                                                                                                                                                                                                                        |
| Any other key                    | A Worker setting as Cloudflare names it: `compatibilityDate`, `compatibilityFlags`, `triggers`, `exports`, `observability`, `placement`, `limits`, `domains`, `workersDev`, `previewUrls`.                                                                            |

`maximus()` owns the Worker's entry (`.maximus/entry.ts`) and a web app's assets, always adds
`nodejs_compat`, turns preview URLs off unless the options turn them on, sets Workers Logs and traces on with
query strings redacted (the options' `observability` joins these defaults key by key), adds a trigger for each
cron and queue module, and declares the development token under `vp dev` alone. It refuses a
`cloudflare.config.ts` or `maximus.config.ts` beside it, an `assets` option and a `DEVELOPMENT_TOKEN` binding in
`env`. It also brings the lint and format presets when the configuration sets no `lint` or `fmt`.
`vite.config.ts` runs in Node, so it may read `process.env`, for a database's id for instance.

## Root modules

Each is optional and default-exports one declaration:

- `errors.ts`: `defineErrors({ noteNotFound: { code: 'NOTE_NOT_FOUND', status: 404, message: '…' } })`, the
  codes `fail` and `failures` accept. See [errors-and-results.md](errors-and-results.md).
- `context.ts`: `defineContext(({ env, principal, fail }) => ({ … }))`, what every handler receives besides
  its input. It runs once per call, after admission; it may answer `fail(code)` instead.
- `auth.ts`: `defineAuth({ resolve, resourceMetadataUrl, resources })`, for tokens the configured issuer does
  not issue. `resolve(token, context)` verifies cryptographically and answers a principal
  `{ actorId, actorKind, organizationId, scopes, client? }`, or a failure: `FORBIDDEN` answers 403, anything
  else 401. The issuer, the audience and every other token setting stay in `vite.config.ts`; `defineAuth`
  refuses them.
- `telemetry.ts`: `defineTelemetry({ enabled, observers, traceId })`, whether Maximus's diagnostics run and
  the observers of every call, such as `analytics({ record })` from `@arbol-ai/maximus/analytics`. Observers
  receive safe metadata alone, never input, output or credentials. See
  [Observability](https://github.com/getarbol/maximus/blob/main/docs/guides/observability.md).

Root modules never import a route or a generated module.

## Bindings and Env

Declare each binding in `env`; `.maximus/env.d.ts` types the global `Env` from them with Cloudflare's own
inference:

```ts
env: {
  NOTES: bindings.kv(),
  NOTES_DB: bindings.d1({ name: 'notes', id: '<the id cf d1 create printed>' }),
  DOCUMENTS: bindings.r2({ name: 'notes-documents' }),
  DIGESTS: bindings.queue({ name: 'note-digests' }),
  COUNTERS: bindings.durableObject({ worker: 'notes', exportName: 'NoteCounter' }),
  BILLING: bindings.worker({ worker: 'billing', exportName: 'Service', props: { caller: 'notes' } }),
  PARTNER_API_KEY: bindings.secret(),
},
```

A binding to one of the Worker's own Durable Object classes is typed as `DurableObjectNamespace` of that
class. What inference cannot know, a queue's message type or another Worker's entrypoint, a module declares:

```ts
declare global {
  interface Env {
    DIGESTS: Queue<DigestMessage>;
    BILLING: Service<BillingService>;
  }
}
```

Under `vp dev` every store is local, in `.cloudflare/state/`, and a secret's value comes from `.dev.vars`.
`bindings.text()` and `bindings.json()` hold readable configuration, never a credential.

## The development token

`maximus init` writes `.dev.vars` with `DEVELOPMENT_TOKEN=<64 hexadecimal characters>`. Under `vp dev` and
`vp test`, a request to `localhost`, `127.0.0.1` or `[::1]` whose bearer token equals `DEVELOPMENT_TOKEN`
(which needs at least 32 characters) signs in the developer `local-developer` of the organization
`local-development` (or `tokens.development`'s `organizationId`), holding every scope the service defines. No build declares it, so a deployed Worker accepts
only the issuer's access tokens.

```sh
curl -H "authorization: Bearer $(cut -d= -f2 .dev.vars)" http://localhost:5173/api/v1/greeting
```

## What prepare generates

`maximus prepare` writes `.maximus/` from `vite.config.ts` and the files, and `vp dev` (when it starts and on
every change), `vp build`, `vp test` and `bun run typecheck` run it. It parses modules and never runs them.

| Module                    | Holds                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`               | The application's configuration from `vite.config.ts`, as data.                                                                   |
| `env.d.ts`                | `Env`.                                                                                                                            |
| `middleware.ts`           | The modules of `middleware/`, apart by phase.                                                                                     |
| `base.ts`                 | The application builder: configuration, `errors.ts`, `auth.ts`, `context.ts`, `telemetry.ts`, MCP Markdown, operation middleware. |
| `register.d.ts`           | `MaximusRegister`: types every handler's context, failures and `Env`.                                                             |
| `app.ts`                  | `app`: every route and tool, built.                                                                                               |
| `worker.ts`, `entry.ts`   | The Worker: `export default` its handler, `export const Service` its RPC entrypoint, and the Durable Object classes.              |
| `http.ts`                 | `handler`: the API as the Worker serves it, for tests in Node.                                                                    |
| `mcp.ts`, `app-routes.ts` | The MCP Markdown, and a web app's pages, when the project has them.                                                               |

The starter's `package.json` maps `#maximus/*` to `.maximus/*.ts`, so tests import `handler` from
`#maximus/http` and `app` from `#maximus/app`. A refusal of `prepare` names the file and keeps the previous
output. `.maximus/` is in `.gitignore`.

## Modes

A project is prepared for `development` under `vp dev` and `vp test`, and for `production` in every build and
preview. A module named `<name>.dev.ts` exists in development alone, `<name>.prod.ts` in production alone.

## The Worker's other parts

| Folder             | A file                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pages/`           | Default-exports an `HttpRoute<Env>`, a public answer at a fixed path outside the API: `pages/index.ts` answers `GET` and `HEAD /`, and `pages/webhooks/payments.post.ts` answers `POST /webhooks/payments`. Other methods answer `405`. A page verifies any data it receives itself, as a webhook verifies its signature. Never tenant data. |
| `crons/`           | Exports `const cron = '*/15 * * * *'`, a string literal that becomes the Worker's trigger, and default-exports an `ExportedHandlerScheduledHandler<Env>`.                                                                                                                                                                                    |
| `queues/`          | Is named after the queue it consumes and default-exports an `ExportedHandlerQueueHandler<Env, unknown>`. The Worker subscribes to the queue unless `triggers` declares its consumer, for batches, retries and a dead letter queue.                                                                                                           |
| `email/`           | Is named after a recipient, or `_default`, and default-exports the email handler.                                                                                                                                                                                                                                                            |
| `durable-objects/` | Default-exports a class that extends `DurableObject<Env>`, exported as the PascalCase of the file's name. Declare it in `exports` (`exports.durableObject({ storage: 'sqlite' })`) and bind it with `bindings.durableObject({ worker, exportName })`. Its name is its storage's: renaming or removing it is a migration in `exports`.        |

A web app is `index.html` at the root, with its pages in `app/routes/` (React Router), its layout in
`app/root.tsx` and its static files in `public/`. The same Worker serves it, and the API stays below `/api`.

Each topic has a guide: [Project structure](https://github.com/getarbol/maximus/blob/main/docs/guides/project-structure.md),
[Bindings](https://github.com/getarbol/maximus/blob/main/docs/guides/bindings.md),
[Background work](https://github.com/getarbol/maximus/blob/main/docs/guides/background-work.md),
[Durable Objects](https://github.com/getarbol/maximus/blob/main/docs/guides/durable-objects.md) and
[Web apps](https://github.com/getarbol/maximus/blob/main/docs/guides/web-apps.md).
