# Configuration

Every option of `maximus()` from `@arbol-ai/vite-plugin`, the project's one configuration, with its type,
its default and its effect, followed by the Worker settings Maximus sets itself and the configurations it
refuses.

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
      compatibilityDate: '2026-10-27',
      env: { NOTES: bindings.kv() },
    }),
  ],
});
```

`maximus(options)` takes the application's options and the Worker's settings in one object, and returns
the plugins Vite runs: Maximus's own, which prepare `.maximus/` and configure the Worker, and Cloudflare's
Vite plugin, which builds and runs it. Under `vp test`, Cloudflare's plugin stays out: tests import the
generated application in Node, where `cloudflare:workers` resolves to a stand-in.

## Application options

| Option           | Type                                                    | Default                                       | Effect                                                                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `origin`         | `string`                                                | Required                                      | The public HTTPS origin that OpenAPI, MCP resources and OAuth discovery advertise, and the tokens' default audience. A `workers.dev` origin is served there; any other becomes the Worker's custom domain, unless `domains` or a fetch trigger routes the Worker. |
| `name`           | `string`                                                | `name` in `package.json`, without its scope   | The service's name: the Worker's, the MCP server's, the `service` that `/health` and observer events report, and the default `namespace`. Lowercase letters, digits and single hyphens, 2 to 63 characters, starting with a letter.                               |
| `namespace`      | `string`                                                | The name                                      | The first part of every scope, `<namespace>:<resource>:<action>`.                                                                                                                                                                                                 |
| `title`          | `string`                                                | The name                                      | The human name that OpenAPI, the MCP server and OAuth discovery show.                                                                                                                                                                                             |
| `version`        | `string`                                                | `version` in `package.json`, else `0.0.0`     | The version that OpenAPI, the MCP server and `/health` report.                                                                                                                                                                                                    |
| `tokens`         | `TokenOptions`                                          | See [tokens](#tokens)                         | How bearer tokens are verified.                                                                                                                                                                                                                                   |
| `rpc`            | `{ callers: readonly string[] }`                        | `{ callers: [] }`                             | The Workers allowed to call RPC methods, by the `caller` their Service Binding's `props` name. See [Worker RPC](../guides/worker-rpc.md).                                                                                                                         |
| `http`           | `{ basePath?: string; healthPath?: string }`            | `{ basePath: '/api', healthPath: '/health' }` | Where the API and the health check answer. Each is an absolute path without a trailing slash or dot segments; `basePath: '/'` serves the API at the root, which a web app refuses.                                                                                |
| `maxBodyBytes`   | `number`                                                | 32 KiB (32 768)                               | The request body limit of every operation that sets none, a positive integer up to 16 MiB.                                                                                                                                                                        |
| `maxOutputBytes` | `number`                                                | 256 KiB (262 144)                             | The output limit of every operation that sets none, a positive integer up to 16 MiB.                                                                                                                                                                              |
| `rateLimit`      | `{ binding: string; retryAfter?: number }`              | None                                          | A rate limiting binding of `env` that every HTTP and MCP call passes after its token is verified, counted per organization and actor. A call over the limit answers `429 RATE_LIMITED` with `Retry-After` of `retryAfter` seconds, 60 by default.                 |
| `env`            | `Record<string, Binding \| false \| null \| undefined>` | `{}`                                          | The Worker's bindings, made with `bindings` from `cf/config`; `Env` is inferred from them. An entry that is `false`, `null` or `undefined` is left out. See [Bindings](../guides/bindings.md).                                                                    |
| `webApp`         | `{ headers?: Record<string, string \| false> }`         | The default headers                           | What a web app's pages and files answer with. See [webApp](#webapp).                                                                                                                                                                                              |

The code that completes the application is not configuration: `errors.ts`, `context.ts`, `auth.ts` and
`telemetry.ts` declare it, as [Project structure](../guides/project-structure.md#configuration-and-root-modules)
describes.

## tokens

| Field                   | Type                                                                                                            | Default                                   | Effect                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issuer`                | `string`                                                                                                        | None                                      | The OAuth authorization server, an absolute HTTPS URL, which a token must name as its `iss`. Required unless `scheme` is `bearer`.                                                                                                                                                                                                              |
| `audience`              | `string \| readonly string[]`                                                                                   | The origin                                | The audience a token must carry, or several, any one of which it may carry; each non-empty and distinct. The first is the resource OAuth discovery names.                                                                                                                                                                                       |
| `jwksUri`               | `string`                                                                                                        | `.well-known/jwks.json`                   | The issuer's JWKS, resolved against `issuer`; HTTPS.                                                                                                                                                                                                                                                                                            |
| `authorizationEndpoint` | `string`                                                                                                        | `authorize`                               | The authorization endpoint OpenAPI publishes, resolved against `issuer`; HTTPS.                                                                                                                                                                                                                                                                 |
| `tokenEndpoint`         | `string`                                                                                                        | `oauth/token`                             | The token endpoint OpenAPI publishes, resolved against `issuer`; HTTPS. A web app's content security policy admits its origin.                                                                                                                                                                                                                  |
| `algorithms`            | `TokenAlgorithm[]`                                                                                              | `['RS256']`                               | The algorithms the issuer signs with: `RS256`, `RS384`, `RS512`, `PS256`, `PS384`, `PS512`, `ES256`, `ES384`, `ES512` or `EdDSA`.                                                                                                                                                                                                               |
| `claims`                | `TokenClaims`                                                                                                   | The standard claims, as Auth0 issues them | Where a token puts the organization (`organization`, `org_id` by default), the scopes (`scopes`, `scope`), the client (`client`, `azp` else `client_id`) and a person's permissions (`permissions`, `permissions`; `false` trusts the scopes alone), and the subject of a machine's token (`machineSubject`, `{client}@clients` or `{client}`). |
| `development`           | `{ binding: string; organizationId?: string } \| false`                                                         | `{ binding: 'DEVELOPMENT_TOKEN' }`        | The token `vp dev` accepts from `localhost`, `127.0.0.1` or `[::1]` as a developer holding every scope, in `organizationId`, `local-development` by default. Only `vp dev` declares its binding, a secret read from `.dev.vars`; a token shorter than 32 characters never matches. `false` accepts none.                                        |
| `scheme`                | `{ type: 'oauth' } \| { type: 'bearer'; description: string } \| { type: 'oauth+bearer'; description: string }` | `{ type: 'oauth' }`                       | How clients obtain tokens, as OpenAPI and discovery publish it. `bearer` and `oauth+bearer` need `resolve` in `auth.ts`.                                                                                                                                                                                                                        |

`resolve`, `resources` and `resourceMetadataUrl` are code, which `auth.ts` declares with `defineAuth`.
[Authentication and scopes](../guides/authentication-and-scopes.md) explains each field.

## webApp

| Field     | Type                              | Default             | Effect                                                                                                                                                                                                                                                             |
| --------- | --------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `headers` | `Record<string, string \| false>` | The default headers | Response headers of a web app's pages and files, merged over the defaults: a header named here replaces the default, and `false` leaves it out. Under `vp dev`, `content-security-policy` and `strict-transport-security` are left out, the options' own included. |

[Web apps](../guides/web-apps.md#headers) lists the default headers.

## Worker settings

Every other option is a setting of the Worker, as `WorkerConfig` from `cf/config` names it. Maximus passes
it to Cloudflare's Vite plugin as it is, except where [What Maximus sets](#what-maximus-sets) says
otherwise.

| Setting              | Effect                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `compatibilityDate`  | Required. The Workers runtime's compatibility date, `YYYY-MM-DD`. `bun create maximus` sets the day the project is created.               |
| `compatibilityFlags` | The runtime's compatibility flags. Maximus adds `nodejs_compat`.                                                                          |
| `domains`            | The custom domains the Worker is served at.                                                                                               |
| `workersDev`         | Whether the Worker is served at `<name>.<subdomain>.workers.dev`.                                                                         |
| `previewUrls`        | Whether each version gets a preview URL.                                                                                                  |
| `triggers`           | Fetch routes, queue consumers, cron schedules, email addresses and sockets, made with `triggers` from `cf/config`.                        |
| `exports`            | The Worker's named exports, made with `exports` from `cf/config`: Durable Object classes and their migrations, entrypoints and Workflows. |
| `observability`      | Workers Logs and traces.                                                                                                                  |
| `placement`          | Where the Worker runs: Smart Placement or a region, host or hostname.                                                                     |
| `limits`             | `cpuMs` and `subrequests`, the limits of one invocation.                                                                                  |
| `tailConsumers`      | The Tail Workers that receive this Worker's events.                                                                                       |
| `cache`              | Whether the Worker's cache is enabled.                                                                                                    |
| `logpush`            | Whether trace events go to Workers Logpush.                                                                                               |
| `access`             | Cloudflare Access, and its simulation under `vp dev`.                                                                                     |
| `unsafe`             | Metadata passed to Cloudflare as it is.                                                                                                   |

`name`, `entrypoint`, `env` and `assets` are the application's or Maximus's own: `name` and `env` are the
options above, and setting `assets` is refused.

## What Maximus sets

| Setting              | Value                                                                                                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`               | The `name` option.                                                                                                                                                                                                                       |
| `entrypoint`         | `./.maximus/entry.ts`, which prepare generates.                                                                                                                                                                                          |
| `compatibilityFlags` | The options' own, with `nodejs_compat`, which Maximus's diagnostics need.                                                                                                                                                                |
| `env`                | The declared bindings; for a web app, `ASSETS`; under `vp dev` alone, the development token's binding as a secret.                                                                                                                       |
| `assets`             | For a web app alone: `{ htmlHandling: 'none', notFoundHandling: 'none', runWorkerFirst: true }`, so the Worker decides every answer.                                                                                                     |
| `workersDev`         | Unless set: `true` when the origin is a `workers.dev` URL, else `false`.                                                                                                                                                                 |
| `domains`            | Unless set, or routed by a fetch trigger: the origin's host, when the origin is not a `workers.dev` URL.                                                                                                                                 |
| `previewUrls`        | `false`, unless set.                                                                                                                                                                                                                     |
| `observability`      | `{ enabled: true, redactQueryString: true, logs: { enabled: true, invocationLogs: true }, traces: { enabled: true } }`, with the options' own merged over it key by key. Logs and traces follow `enabled` unless the options set theirs. |
| `triggers`           | The options' own; then one cron trigger for each distinct schedule the cron modules state, unless the options declare it; then one consumer trigger for each queue module whose queue the options do not consume.                        |

So `observability: { headSamplingRate: 0.1 }` samples a tenth of the requests and keeps everything else on,
query strings redacted; `observability: { logs: { invocationLogs: false } }` turns invocation logs off
alone; and `observability: { enabled: false }` turns logs and traces off with it. See
[Observability](../guides/observability.md).

Two settings of the build follow too. The Worker's build is minified unless the configuration sets
`build.minify`; the browser's build of a web app keeps Vite's default. And unless `vite.config.ts` sets
`lint` or `fmt` itself, `maximus()` brings the Maximus lint and format presets, given that `oxlint`, `oxfmt`
and `ultracite` are installed; see [Lint and format](../guides/lint-and-format.md).

## Development and production

`vp dev` runs the Worker for development. Every build and preview is production, whatever Vite's `--mode`,
and `vp test` prepares the project for development:

| Mode          | Commands                              | Differs by                                                                                                                                                                                      |
| ------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `development` | `vp dev`, `vp test`                   | Declares the development token's binding and accepts its token from `localhost`; includes `.dev` modules; a web app reaches Vite's modules and leaves its content security policy and HSTS out. |
| `production`  | `vp build`, `vp preview`, `cf deploy` | Includes `.prod` modules. Nothing that exists for development is built.                                                                                                                         |

## Refusals

`vp dev`, `vp build` and `vp test` refuse a configuration that would build another Worker than the project
describes, before anything runs:

| Message                                                                                                                          | When                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `Name the service with maximus({ name }), or in package.json: lowercase letters, digits and single hyphens.`                     | Neither `name` nor `package.json` gives a name a Worker can take.                       |
| `maximus() configures the application: move maximus.config.ts into maximus()'s options.`                                         | A `maximus.config.ts` is in the project.                                                |
| `maximus() configures the Worker: move cloudflare.config.ts into maximus()'s options.`                                           | A `cloudflare.config.ts` is in the project.                                             |
| `maximus() configures the assets: index.html at the root makes the project a web app.`                                           | The options set `assets`.                                                               |
| `DEVELOPMENT_TOKEN is the development token: Maximus declares it under vp dev alone, so no deployed Worker carries it.`          | `env` declares the development token's binding, named as `tokens.development` names it. |
| `ASSETS serves the web app index.html starts: Maximus declares it.`                                                              | A web app's `env` declares `ASSETS`.                                                    |
| `maximus() serves a web app from the root with its hashed files below /assets: keep base and build.assetsDir at their defaults.` | A web app's Vite `base` is not `/`, or its `build.assetsDir` is not `assets`.           |
| `<file>: export the schedule as a string literal, export const cron = '0 8 * * *'.`                                              | A cron module states no literal schedule.                                               |

`maximus prepare` refuses a name, `assets` and the two reserved bindings too. What prepare refuses in the
project's files is listed in [Project structure](../guides/project-structure.md#what-prepare-refuses).

When the Worker starts, or a test imports the application, the application refuses options that break its
rules, with a `TypeError`:

| Message                                                                                                                                    | When                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `Application origin must use HTTPS.`                                                                                                       | `origin` is not an `https:` URL.                                                                |
| `A scope namespace is required.`                                                                                                           | `namespace` is not a lowercase letter followed by 1 to 63 lowercase letters, digits or hyphens. |
| `tokens.issuer is required to verify or document OAuth access tokens.`                                                                     | `tokens.issuer` is missing and `scheme` is not `bearer`.                                        |
| `tokens.issuer, jwksUri, authorizationEndpoint and tokenEndpoint must be absolute HTTPS URLs, the last three resolved against the issuer.` | One of them is not an HTTPS URL.                                                                |
| `tokens.audience must be a non-empty string or a non-empty list of distinct non-empty strings.`                                            | The audience is empty or repeats one.                                                           |
| `tokens.algorithms lists one or more asymmetric JWS algorithms.`                                                                           | `algorithms` is empty or names another algorithm.                                               |
| `tokens.claims names each claim by a non-empty string (permissions may be false), and machineSubject is {client}@clients or {client}.`     | A claim name is empty, or `machineSubject` is another value.                                    |
| `tokens.development names the binding of its token and a valid organization id.`                                                           | `development.binding` is empty, or `organizationId` is not an organization id.                  |
| `The application body limit is a positive integer up to 16 MiB.`                                                                           | `maxBodyBytes` is out of range. `maxOutputBytes` has its own message.                           |
| `HTTP basePath must be an absolute path without a trailing slash or dot segments.`                                                         | `http.basePath` is malformed.                                                                   |
| `HTTP healthPath must be an unreserved absolute path.`                                                                                     | `http.healthPath` is malformed, versioned or one of the API's own paths.                        |
