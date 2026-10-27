# Building a service

For the API-first project layout, use `maximus init <directory> --name <name> --layout project`.
`vite.config.ts` is its only configuration: `maximus()` from `@arbol-ai/vite-plugin` states the origin,
token issuer, compatibility date and bindings (`env: { NAME: bindings.kv() }` from `cf/config`), and `Env`
is generated from them. `errors.ts`, `context.ts` (`defineContext`) and `auth.ts` (`defineAuth`) complete
the application in code; 7.4 projects keep `maximus.config.ts`. `src/` is optional domain code. Each route file
default-exports one `defineHandler` from `@arbol-ai/maximus`: `routes/v1/tasks/[taskId].delete.ts` answers
`DELETE /v1/tasks/{taskId}`, and the operation name, effect and scope derive from the method and path unless
declared. The handler receives `{ input, principal, env, fail, …context }` and returns its output or
`fail(code)`. `mcp/tools/<name>.ts` default-exports a `defineTool` only MCP serves. A root `errors.ts`
types every handler's failures. The 7.4 `export const GET = defineRoute(…)` modules keep working.
`defineMiddleware` (also named `defineRequestMiddleware`) wraps HTTP requests; `defineOperationMiddleware` runs after native admission on
HTTP, MCP and RPC. Middleware files run in filename order. The Vite+ plugin reconciles entries on
builds and source changes. A cron module's literal schedule becomes its trigger; queues, email routing
and Durable Object exports are Worker settings of `maximus()`. Legacy route factories and explicit service composition below
remain supported. Read `docs/guides/project-structure.md` for configuration, migration and conventions.

## Packages

```sh
bun add @arbol-ai/maximus          # everything: /workers, /mcp, the maximus CLI, …
bun add -d cf vite @cloudflare/vite-plugin@beta typescript @cloudflare/workers-types
```

## Layout

```text
src/
  application.ts      export const base = maximus<Env>({ ... })
  tokens.ts           the TokenPolicy (issuer, audience, optional resolve)
  env.ts              Env: the bindings, typed by the narrow interfaces the code uses
  api/<resource>/
    schemas.ts        TypeBox schemas
    <resource>.ts     named domain functions
    operations.ts     export const <resource> = base.operation(...)...
  app.ts              export const app = base.mount(a).mount(b).build()   (no cloudflare:workers import)
  index.ts            createWorker(app, ...) and the exports
cloudflare.config.ts  the Worker for cf: name, runtime, entrypoint, bindings, triggers, exports
vite.config.ts        cloudflare() from @cloudflare/vite-plugin, which cf builds and runs with
```

`app.ts` must stay importable outside workerd so tests and scripts can load it.

## Configuration

```ts
import { defineErrors, maximus } from '@arbol-ai/maximus';

export const errors = defineErrors({
  noteNotFound: { code: 'NOTE_NOT_FOUND', status: 404, message: 'The note does not exist.' },
});

export const base = maximus<Env>({
  name: 'notes',                         // lowercase; health, MCP server name, telemetry
  namespace: 'notes',                    // ^[a-z][a-z0-9-]{1,63}$, prefixes every scope
  title: 'Notes',
  version: '1.0.0',
  origin: 'https://notes.example.com',   // must be https:, the public URL
  tokens: { issuer: 'https://auth.example.com/', audience: 'https://notes.example.com' },
  errors,
  rpc: { callers: [] },                  // deployments allowed over native RPC
  // optional: mcp, telemetry, rateLimit, maxBodyBytes, maxOutputBytes
});
```

- `tokens.issuer` has no default. Without it the app builds, but OAuth tokens are refused and
  `/openapi.json` answers 500.
- `mcp` configuration requires `transports: [mcp()]` in `createWorker`, or the Worker fails to start.

## Tokens

Default: OAuth access tokens from any provider, RS256 (or `tokens.algorithms`) from
`<issuer>.well-known/jwks.json` (or `tokens.jwksUri`), exact issuer and audience (`tokens.audience`
may list several, any one accepted; the first is the discovery `resource`). Standard claims: `sub`
(actor; `<client>@clients` is a machine), `org_id` (required; 1-128 letters, digits, `_`, `-`),
`azp`/`client_id` (optional), `scope`; a person holds only the scopes their `permissions` claim also
lists, none without it (Auth0 with RBAC and permissions in the token). `tokens.claims` maps providers
that name them differently: `{ scopes: 'scp', client: 'cid', permissions: false, machineSubject:
'{client}' }` (Okta), `{ scopes: 'permissions' }` (WorkOS session tokens). Set `permissions: false`
only when the authorization server grants each person no more than they may hold, and
`machineSubject: '{client}'` only when it assigns every client id. OpenAPI's OAuth flows use
`tokens.authorizationEndpoint` and `tokens.tokenEndpoint` (Auth0's `authorize` and `oauth/token` by
default); for other providers copy them and `jwksUri` from the server's
`/.well-known/oauth-authorization-server` metadata.

Other credentials: `tokens.resolve(token, context)` verifies cryptographically and returns a
`TokenPrincipal` (`{ actorId, actorKind, organizationId, scopes, client? }`) or a `Result`
(`FORBIDDEN` → 403, any other failure or a throw → 401). `context` has `env`, `request`, `surface`,
`applicationScopes`, `background`. Return a `client` so calls carry `authority`.

`tokens.scheme`: `{ type: 'bearer', description }` for application-issued tokens (needs `resolve`, no
OAuth discovery, cannot mount MCP); `{ type: 'oauth+bearer', description }` for OAuth people plus
resolver-verified workload keys (every operation in the OpenAPI document declares `actorKinds`).

Local development (`examples/minimal-http/src/tokens.ts`): `tokens.development: { binding:
'DEVELOPMENT_TOKEN' }` accepts that token, at least 32 characters, from `.dev.vars` only from
`localhost`/`127.0.0.1`/`[::1]`, as `local-developer` holding every declared scope; every other token is
verified as usual. Never write that resolver by hand.

## Env

Type bindings by what the code uses, so tests can fake them without casts:

```ts
export interface NoteStore {
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string) => Promise<void>;
}
export interface Env {
  NOTES: NoteStore; // a KVNamespace satisfies it
  PRICING: Service<typeof PricingService>; // RPC binding typed from the owner's entrypoint
}
```

## The Worker

```ts
import { mcp } from '@arbol-ai/maximus/mcp';
import { createWorker } from '@arbol-ai/maximus/workers';

import { app } from './app';

const worker = createWorker(app, {
  transports: [mcp()],                 // serves the MCP tools; required by app mcp configuration
  // routes, http: { basePath, origins, mounts, before, aroundOperation, fallback, healthPath },
  // assets, handlers: { scheduled, queue }
});

export default worker.handler;
export const NotesService = worker.entrypoint; // if any operation declares rpc
```

## cloudflare.config.ts

```ts
import { bindings, defineConfig } from 'cf/config';

import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

export default defineConfig(({ mode }) => ({
  worker: {
    name: 'notes',
    compatibilityDate: '2026-10-12',
    compatibilityFlags: ['nodejs_compat'], // required: node:async_hooks
    entrypoint,
    observability: { enabled: true },
    env: {
      NOTES: bindings.kv(), // no id: cf deploy provisions it
      DEVELOPMENT_TOKEN: mode === 'development' && bindings.secret(), // cf dev only, from .dev.vars
    },
  },
}));
```

`cf` is in beta and needs Node 22+. Wrangler files are not read: convert one with `cf migrate`.

## Run locally

```sh
echo "DEVELOPMENT_TOKEN=$(openssl rand -hex 32)" > .dev.vars
bunx cf dev                       # Vite on http://localhost:5173
curl -s http://localhost:5173/health
curl -s http://localhost:5173/openapi.json
curl -s http://localhost:5173/v1/notes -H "authorization: Bearer $(sed 's/^DEVELOPMENT_TOKEN=//' .dev.vars)"
```

Several Workers together: the caller's `vite.config.ts` runs the others as auxiliary Workers,
`cloudflare({ auxiliaryWorkers: [{ config: otherWorker, devOnly: true }] })`.

## Native endpoints (served automatically)

`/` (name, OpenAPI path, MCP path), `/health`, `/openapi.json`, `/openapi.yaml`, `/openapi.yml`,
`/.well-known/oauth-protected-resource` and `…/mcp`. They are reserved paths.
