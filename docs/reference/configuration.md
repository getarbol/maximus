# Configuration reference

Every option of `maximus()`, `createWorker()`, `createHttpHandler()`, `mcp()` and the optional
observers. Operation options are in the [operation reference](operations.md).

## Application

`maximus<Env>(configuration)` creates the base builder. `Env` is the type of the Worker's bindings;
the configuration's type is `ApplicationConfiguration<Env>`.

| Option           | Type                                          | Required | Meaning                                                                                                                        |
| ---------------- | --------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `name`           | `string`                                      | Yes      | Service identifier: MCP server name, `/health` `service`, telemetry `service`. Use lowercase letters, digits and hyphens.      |
| `namespace`      | `string`                                      | Yes      | Prefix of every scope. `^[a-z][a-z0-9-]{1,63}$`.                                                                               |
| `title`          | `string`                                      | Yes      | Human name: OpenAPI `info.title`, `resource_name`, the root endpoint's `name`.                                                 |
| `version`        | `string`                                      | Yes      | OpenAPI `info.version`, MCP server version, `/health` `version`.                                                               |
| `origin`         | `string`                                      | Yes      | Public HTTPS base URL, advertised by OpenAPI, MCP resources and OAuth discovery. Must be `https:`.                             |
| `tokens`         | `TokenPolicy<Env>`                            | Yes      | How bearer tokens are verified and documented. See [tokens](#tokens).                                                          |
| `errors`         | `ErrorCatalog`                                | Yes      | The result of `defineErrors(...)`.                                                                                             |
| `rpc`            | `{ callers: string[] }`                       | Yes      | Deployments allowed to call native RPC methods, by their binding props' `caller`. `[]` for none.                               |
| `mcp`            | `McpConfiguration`                            | No       | The MCP server's instructions, guides and skills; requires the MCP transport. Tools need only the transport. See [mcp](#mcp).  |
| `telemetry`      | `TelemetryConfig<Env>`                        | No       | See [telemetry](#telemetry).                                                                                                   |
| `rateLimit`      | `{ binding: keyof Env; retryAfter?: number }` | No       | A Workers rate limiting binding applied after authentication, per organization and actor. `retryAfter` defaults to 60 seconds. |
| `maxBodyBytes`   | `number`                                      | No       | Default request body limit for operations. Default 32 768; at most 16 MiB.                                                     |
| `maxOutputBytes` | `number`                                      | No       | Default output limit, a positive integer up to 16 MiB (checked by `.build()`). Default 262 144 (256 KiB).                      |

`.build()` throws a `TypeError` when the configuration or any operation breaks a rule; the message
states the rule and, for most operation rules, the operation's name.

## tokens

| Option                  | Type                                                                                            | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audience`              | `string \| string[]`                                                                            | Required. The audience access tokens must carry, or a list of audiences any one of which they may carry (the service's own and a gateway's in front of it, so the service accepts both). The first is the canonical resource: the `resource` OAuth discovery names. `.build()` refuses an empty audience, an empty list and a repeated audience.                                                                                                                                                                                                                                             |
| `issuer`                | `string`                                                                                        | The OAuth authorization server, HTTPS. Required unless the scheme is `bearer` (the application issues its own tokens): `.build()` refuses a missing, relative or non-HTTPS issuer, or a non-HTTPS `jwksUri`, rather than failing every token at run time. OpenAPI's authorization and token URLs are `authorizationEndpoint` and `tokenEndpoint`.                                                                                                                                                                                                                                            |
| `jwksUri`               | `string`                                                                                        | The JWKS URL, resolved against `issuer`. Default `.well-known/jwks.json`. HTTPS only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `authorizationEndpoint` | `string`                                                                                        | The authorization endpoint OpenAPI publishes for the authorization-code flow, resolved against `issuer`. Default `authorize`. HTTPS only.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `tokenEndpoint`         | `string`                                                                                        | The token endpoint OpenAPI publishes for both flows, resolved against `issuer`. Default `oauth/token`. HTTPS only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `algorithms`            | `TokenAlgorithm[]`                                                                              | The algorithms the issuer signs with: `RS256`, `RS384`, `RS512`, `PS256`, `PS384`, `PS512`, `ES256`, `ES384`, `ES512` or `EdDSA`. Default `['RS256']`.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `claims`                | `TokenClaims`                                                                                   | Where the access tokens put the organization (`organization`, default `org_id`), the scopes (`scopes`, default `scope`), the client (`client`, default `azp`, else `client_id`) and what a person may do (`permissions`, default `permissions`, whose list a person's scopes must also appear in; `false` trusts the scopes alone): each a claim name or a dotted path such as `tenant.id`. `machineSubject` is the subject of a machine's token: `'{client}@clients'`, the default, or `'{client}'`. See [OAuth access tokens](../guides/authentication-and-scopes.md#oauth-access-tokens). |
| `development`           | `{ binding: string; organizationId?: string }`                                                  | The env binding of a token accepted from `localhost`, `127.0.0.1` or `[::1]` as a developer holding every scope the application declares, in `organizationId` (default `local-development`). At least 32 characters, or it never matches. See [Local development](../guides/authentication-and-scopes.md#local-development).                                                                                                                                                                                                                                                                 |
| `resolve`               | `(token, context?) => Promise<TokenPrincipal \| Result<TokenPrincipal, Failure>>`               | Replaces the OAuth verification. See [custom verification](../guides/authentication-and-scopes.md#custom-verification).                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `scheme`                | `{ type: 'oauth' } \| { type: 'bearer'; description } \| { type: 'oauth+bearer'; description }` | How clients obtain tokens. Default `oauth`. `bearer` and `oauth+bearer` require `resolve`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `resourceMetadataUrl`   | `string \| null \| (context) => string \| null`                                                 | The URL in the `401` challenge. `null` sends a plain `Bearer` challenge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `resources`             | `Record<string, OAuthResource<Env>>`                                                            | Protected-resource metadata documents by absolute path below `/.well-known/oauth-protected-resource`. Replaces the inferred ones, so `.build()` requires `resourceMetadataUrl` with any configured resource.                                                                                                                                                                                                                                                                                                                                                                                 |

`OAuthResource<Env>`: `audience` (`string` or `(env) => string`), `authorizationServers`
(`string[]` or `(env) => string[]`, HTTPS, no query) and `scopes` (`string[]`).

`TokenResolutionContext<Env>` (the resolver's `context`): `env`, `request`, `surface`
(`'http' | 'mcp'`), `applicationScopes` (`readonly string[]`) and optional `background`.

`TokenPrincipal`: `actorId` (1–255 characters), `actorKind` (`'user' | 'service'`),
`organizationId` (`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`), `scopes` (at most 1000) and optional
`client: { id, class: 'human' | 'machine' | 'dcr' }`.

## telemetry

| Option      | Type                          | Meaning                                                                                               |
| ----------- | ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `enabled`   | `boolean \| (env) => boolean` | Turns every Maximus diagnostic output on or off. Default `true`.                                      |
| `observers` | `Observer<Env>[]`             | Receive execution and admission events and unexpected errors.                                         |
| `traceId`   | `() => string \| null`        | Returns the active exporter's real trace id (32 hex characters). Anything else is recorded as `null`. |

`Observer<Env>`: optional `execution(event, env)`, `admission(event, env)` (both returning a
`Promise`) and `error(error, surface, requestId?)`. Event fields are in the
[wire formats reference](wire-formats.md#telemetry-events).

## mcp

| Option         | Type                            | Meaning                                                                                                                                                                                |
| -------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instructions` | `string`                        | Server guidance returned when a client initializes.                                                                                                                                    |
| `guides`       | `{ name, title, text }[]`       | Markdown served as resources (`<origin>/guides/<name>`) and prompts. Names `^[a-z][a-z0-9-]{0,63}$`, unique.                                                                           |
| `skills`       | `{ name, description, text }[]` | Agent Skills served through the MCP Skills extension. Names: lowercase words joined by single hyphens, at most 64 characters, unique. Descriptions: one line, at most 1024 characters. |
| `skillTool`    | `string`                        | Also serve the skills through one read-only tool with this name. Requires skills; `^[a-z][A-Za-z0-9_]{0,63}$`; no operation may use it.                                                |

## createWorker

`createWorker(app, options?)` from `@arbol-ai/maximus/workers`; `options` is a `WorkerOptions<Env>`.

| Option       | Type                                                        | Meaning                                                                        |
| ------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `transports` | `HttpTransport[]`                                           | Protocol transports, such as `mcp()`. One MCP transport at most.               |
| `routes`     | `Record<string, HttpRoute<Env>>`                            | Plain routes by exact path.                                                    |
| `http`       | `HttpOptions` without `transports`, `routes` and `annotate` | See [http](#http).                                                             |
| `assets`     | `WorkerAssetsOptions<Env>`                                  | Static assets. Cannot be combined with `http.fallback`. See [assets](#assets). |
| `handlers`   | `Omit<ExportedHandler<Env>, 'fetch'>`                       | Other handlers (`scheduled`, `queue`, …) merged into the default export.       |

It returns `{ handler, entrypoint, service, durableObject }`; see
[Worker composition](../guides/worker-composition.md).

`HttpRoute<Env>` is `(request, env, context: RouteContext) => Promise<Response>`, where `RouteContext`
is `{ requestId, fail(failure, headers?), waitUntil(promise) }`.

## http

`HttpOptions<Env>` (type exported from `@arbol-ai/maximus`, and from `@arbol-ai/maximus/internals`):

| Option                 | Type                                                         | Meaning                                                                                      |
| ---------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `origins`              | `string[]`                                                   | Exact HTTPS origins. Others answer `404` first.                                              |
| `basePath`             | `string`                                                     | Mount operations and discovery below this path. Absolute, no trailing slash or dot segments. |
| `healthPath`           | `string`                                                     | Absolute liveness path. Default: `/health` below `basePath`.                                 |
| `mounts`               | `Record<string, HttpRoute<Env>>`                             | Prefix protocol handlers; a prefix owns its slash-delimited descendants.                     |
| `before`               | `(request, env, context) => Response \| null \| Promise<…>`  | Runs for every request before routing; `null` continues.                                     |
| `aroundOperation`      | `(request, env, { name, effect }, run) => Promise<Response>` | Wraps matched HTTP operations; call `run(scopedEnv)` exactly once.                           |
| `fallback`             | `HttpRoute<Env>`                                             | Answers paths outside every reserved namespace.                                              |
| `verify`               | `(token) => Promise<unknown>`                                | Replaces JWT verification with your claims. A test seam; never use it in production.         |
| `transports`, `routes` |                                                              | As in `createWorker`, for `createHttpHandler`.                                               |
| `annotate`             | `(operation, requestId) => void`                             | Called for each executed operation; `createWorker` uses it for span attributes.              |

`createHttpHandler(app, options?)` returns `(request, env, background?) => Promise<Response>`, the
handler `createWorker` serves. `background` is anything with `waitUntil`, such as the Workers
`ExecutionContext`.

## assets

`WorkerAssetsOptions<Env>`:

| Option              | Type                                           | Meaning                                                               |
| ------------------- | ---------------------------------------------- | --------------------------------------------------------------------- |
| `binding`           | The name of a binding with `fetch`             | The Workers assets binding.                                           |
| `pages.paths`       | `string[]`                                     | Single-page application routes that receive the shell.                |
| `pages.patterns`    | `RegExp[]`                                     | More page routes; no global or sticky flags.                          |
| `pages.shell`       | `string`                                       | The shell file. Default `/index.html`.                                |
| `files`             | `string[]`                                     | Named files served with `no-cache`.                                   |
| `immutablePrefixes` | `string[]`                                     | Namespaces of content-hashed files served as immutable. Not `/`.      |
| `headers`           | `HeadersInit \| (request, env) => HeadersInit` | Browser policy headers. Cannot set `content-type` or `cache-control`. |

## The MCP transport

`mcp(options?)` from `@arbol-ai/maximus/mcp`. `options.path` is the endpoint, `/mcp` by default; `/`
mounts it at the root of its host. The endpoint requires the scope `<namespace>:mcp:use`.

## analytics

`analytics<Env>(options)` from `@arbol-ai/maximus/analytics` returns an `Observer<Env>`:

| Option    | Type                                               | Meaning                                                            |
| --------- | -------------------------------------------------- | ------------------------------------------------------------------ |
| `record`  | `(env, event: ExecutionEvent) => Promise<unknown>` | Your sink. Answering `{ ok: false }` counts as a delivery failure. |
| `enabled` | `boolean \| (env) => boolean`                      | Default `true`. Also off when telemetry is off.                    |

## The typed client

`createClient<typeof app>(baseUrl, token, options?)` from `@arbol-ai/maximus/client`. Its options are
in the [typed client guide](../guides/typed-client.md#options).
