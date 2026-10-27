# Package exports

Every entry point of `@arbol-ai/maximus`, which is released together with `create-maximus` at one
version, and every name each one exports, in the order the entry declares it. The packages are side-effect
free, so a bundle carries only the entries it imports: import from the narrowest entry you need.

| Entry                           | For                                                                    | Runs in                                            |
| ------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------- |
| `@arbol-ai/maximus`             | Routes, tools, the builder, schemas, failures, tokens, HTTP, telemetry | A Worker, or Node                                  |
| `@arbol-ai/maximus/schemas`     | Schemas, validators and input codecs                                   | Anywhere, a browser included                       |
| `@arbol-ai/maximus/errors`      | Error catalogs                                                         | Anywhere, a browser included                       |
| `@arbol-ai/maximus/failures`    | The standard failures as plain data                                    | Anywhere, without a schema library                 |
| `@arbol-ai/maximus/body`        | Bounded body readers                                                   | Anywhere, a browser included                       |
| `@arbol-ai/maximus/webhooks`    | Webhook signature verification                                         | Anywhere, a browser included                       |
| `@arbol-ai/maximus/http-paths`  | Route templates and the router                                         | Anywhere, a browser included                       |
| `@arbol-ai/maximus/projection`  | Names and query kinds derived from OpenAPI documents                   | Anywhere, a browser included                       |
| `@arbol-ai/maximus/diagnostics` | Diagnostics and request correlation for code beside the operations     | A Worker, or Node                                  |
| `@arbol-ai/maximus/internals`   | The interface for transports and adapters                              | A Worker, or Node                                  |
| `@arbol-ai/maximus/workers`     | The Worker: fetch handler, RPC entrypoint, instrumented classes        | A Worker                                           |
| `@arbol-ai/maximus/mcp`         | The MCP transport                                                      | A Worker, or Node                                  |
| `@arbol-ai/maximus/analytics`   | An observer that records analytics events                              | A Worker, or Node                                  |
| `@arbol-ai/maximus/postgres`    | Tenant-scoped Postgres transactions                                    | Where `pg` runs; `pg` is an optional peer          |
| `@arbol-ai/maximus/testing`     | A contract check of a running service                                  | Node                                               |
| `@arbol-ai/maximus/oxfmt`       | The format preset                                                      | Node, with the optional peers oxfmt and Ultracite  |
| `@arbol-ai/maximus/oxlint`      | The lint preset                                                        | Node, with the optional peers oxlint and Ultracite |
| `@arbol-ai/maximus/project`     | The Worker of a project                                                | A Worker                                           |
| `@arbol-ai/maximus/vite`        | `maximus()`, the project's configuration in `vite.config.ts`           | Node, under Vite+                                  |
| `@arbol-ai/maximus/config`      | What a project's files declare and what `.maximus/` binds them with    | Anywhere                                           |

The entries a browser may import reach no Node or Workers module, no MCP SDK and no Postgres driver; the
release checks read their import graphs to make sure. The root reaches `node:async_hooks`, where each
call's diagnostics live, so a Worker that imports it needs the `nodejs_compat` compatibility flag, which
`maximus()` adds, and a browser imports its types alone, or `/schemas`.

## @arbol-ai/maximus

The core: the builder a Worker composed by hand builds its application with, and what a project's files
declare their routes, tools, context, failures and tokens with.

### The application builder

| Export                     | Kind     | What it is                                                                                                                           |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `maximus`                  | function | Starts an application in code: `maximus<Env>(configuration)`, then `.derive()`, `.use()`, `.operation()`, `.mount()` and `.build()`. |
| `ApplicationBuilder`       | type     | An application under construction, as `maximus()` returns it.                                                                        |
| `ApplicationConfiguration` | type     | What `maximus()` takes: identity, origin, `tokens`, `errors`, `rpc`, and the optional limits, rate limit, telemetry and `mcp`.       |
| `AppManifest`              | type     | A built application: its configuration and its operations.                                                                           |
| `Exposure`                 | type     | Where an operation is reachable: `http`, `mcp`, `rpc`, `visibility` and `actorKinds`.                                                |
| `OperationShape`           | type     | An operation as an application holds it.                                                                                             |
| `OperationScope`           | type     | One scope, or a non-empty list of scopes.                                                                                            |
| `OperationMiddleware`      | type     | `(context, next) => Promise<Result>`: what `.use()` and `defineOperationMiddleware` take.                                            |
| `Invocation`               | type     | What preparation and middleware start from: `env`, `principal`, `authority`, `input`, `operation`, `background`, `body`.             |
| `InvocationAuthority`      | type     | What admission verified about a call's token: `surface`, `scopes`, `client` and `token`.                                             |
| `McpConfiguration`         | type     | The MCP server's description: `instructions`, `guides`, `skills` and `skillTool`.                                                    |
| `McpGuide`                 | type     | A guide: `name`, `title` and `text`.                                                                                                 |
| `McpSkill`                 | type     | An Agent Skill: `name`, `description` and `text`.                                                                                    |
| `isPublicOperation`        | function | Whether an operation belongs in the public OpenAPI document and discovery: not `internal`.                                           |
| `operationScopes`          | function | An operation's scopes, as a list.                                                                                                    |
| `operationMatchesScopes`   | function | Whether granted scopes admit an operation, by its `scopeMatch`.                                                                      |

See [Worker composition](../guides/worker-composition.md).

### Routes and tools

| Export               | Kind     | What it is                                                                                                     |
| -------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `defineAuth`         | function | `auth.ts`'s default export: `resolve`, `resources` and `resourceMetadataUrl`. Refuses any other token setting. |
| `defineContext`      | function | `context.ts`'s default export: what every handler receives besides its input, or `fail(code)`.                 |
| `defineHandler`      | function | A route file's default export: `defineHandler(handler, contract?)`.                                            |
| `defineTelemetry`    | function | `telemetry.ts`'s default export: `enabled`, `observers` and `traceId`. Refuses any other field.                |
| `defineTool`         | function | A file of `mcp/tools/`'s default export: `defineTool(handler, contract)`.                                      |
| `AuthOptions`        | type     | The fields `defineAuth` takes.                                                                                 |
| `ContextArguments`   | type     | What `defineContext`'s function receives: the invocation and `fail`.                                           |
| `ContextDeclaration` | type     | What `defineContext` returns.                                                                                  |
| `DomainCode`         | type     | The codes of the project's error catalog, the standard ones left out: what `failures` lists.                   |
| `Fail`               | type     | The type of `fail`: a code, then the data the code declares.                                                   |
| `Failed`             | type     | A failure a handler answers with `fail(code)`.                                                                 |
| `HandlerAnswer`      | type     | What a handler answers: its output or a `Failed`, at once or as a promise.                                     |
| `HandlerArguments`   | type     | What a handler receives: the context, `input`, `fail` and, for a byte body, `body`.                            |
| `HandlerDeclaration` | type     | What `defineHandler` returns.                                                                                  |
| `HandlerHttp`        | type     | The HTTP options a route may set: `body`, `headers`, `response` and `successStatus`.                           |
| `HandlerMcp`         | type     | A route's tool: `name`, `idempotent` and `openWorld`.                                                          |
| `HandlerOptions`     | type     | A route's contract. A contract kept in a `const` keeps its types with `satisfies HandlerOptions`.              |
| `PreparedContext`    | type     | `PreparedContext<typeof context>`: the invocation plus what `context.ts` prepares, for operation middleware.   |
| `RouteBody`          | type     | A byte body's reader, `read()`, as a route's handler receives it.                                              |
| `SchemaOf`           | type     | The schema a contract's `input` or `output` stands for.                                                        |
| `SchemaOrFields`     | type     | A schema, or the fields of a strict object.                                                                    |
| `ToolDeclaration`    | type     | What `defineTool` returns.                                                                                     |
| `ToolOptions`        | type     | A tool's contract.                                                                                             |

See [Project structure](../guides/project-structure.md), [Routes](../guides/routes.md) and
[Context and middleware](../guides/middleware-and-context.md).

### Schemas

| Export                   | Kind           | What it is                                                                                                            |
| ------------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------- |
| `Type`, `t`              | constant       | [TypeBox](https://github.com/sinclairzx81/typebox)'s schema builder.                                                  |
| `Static`                 | type           | The TypeScript type of a schema's values.                                                                             |
| `TSchema`                | type           | Any TypeBox schema.                                                                                                   |
| `parseInput`             | function       | Checks a value against a schema without decoding it: a `Result` of the value, or `INVALID_INPUT`.                     |
| `parseSchema`            | function       | Checks a value against a schema and returns it typed, or throws a `TypeError` that names no value.                    |
| `EmptyInputSchema`       | schema         | The empty strict object: the input of an operation that takes none.                                                   |
| `OrganizationIdSchema`   | schema         | An organization id: 1 to 128 letters, digits, `_` and `-`, starting with a letter or a digit, named `OrganizationId`. |
| `UuidSchema`             | schema         | A lowercase UUID of version 1 to 8, named `Uuid`.                                                                     |
| `DeletedObjectSchema`    | schema         | What a delete answers: `id` and `deleted: true`, named `DeletedObject`.                                               |
| `EmailAddressSchema`     | schema         | An email address of at most 254 characters, named `EmailAddress`.                                                     |
| `HexColorSchema`         | schema         | A `#rrggbb` color, named `HexColor`.                                                                                  |
| `HttpsUrlSchema`         | schema         | An HTTPS URL of at most 2048 characters, named `HttpsUrl`.                                                            |
| `NamedReferenceSchema`   | schema         | Another resource by its `id` and `name`, named `NamedReference`.                                                      |
| `PhoneNumberSchema`      | schema         | A phone number in E.164 format, named `PhoneNumber`.                                                                  |
| `PostalAddressSchema`    | schema         | A postal address shaped as FHIR `Address`, every field optional, named `PostalAddress`.                               |
| `SignedUrlSchema`        | schema         | A link that grants access until it expires: `url` and `expiresAt`, named `SignedUrl`.                                 |
| `DeletedObject`          | type           | A value of `DeletedObjectSchema`.                                                                                     |
| `NamedReference`         | type           | A value of `NamedReferenceSchema`.                                                                                    |
| `PostalAddress`          | type           | A value of `PostalAddressSchema`.                                                                                     |
| `SignedUrl`              | type           | A value of `SignedUrlSchema`.                                                                                         |
| `Page`                   | function, type | `Page(item, { $id })`, the output of a list of `item`; and `Page<Item>`, one page as a handler returns it.            |
| `PageInfoSchema`         | schema         | Whether a list's neighboring pages exist, and their cursors, named `PageInfo`.                                        |
| `PageQueryFields`        | constant       | A list's query fields, `cursor`, `direction` and `limit`, to spread into its input.                                   |
| `pageLimit`              | function       | A list's `limit` field with its own maximum and default: 100 and 25 unless given.                                     |
| `PageInfo`               | type           | A value of `PageInfoSchema`.                                                                                          |
| `PageQuery`              | type           | The list query a handler receives, its defaults applied.                                                              |
| `TPage`                  | type           | The TypeBox type of a `Page` schema.                                                                                  |
| `AttachmentOutputSchema` | schema         | The output of a route that answers a file (`http.response: 'attachment'`).                                            |
| `Attachment`             | type           | A file a route answers with: `body`, `contentType`, `filename` and `byteLength`.                                      |
| `BinaryBody`             | type           | A byte body's reader, `read()`, as an operation of the builder receives it.                                           |
| `BodyFailure`            | type           | Why a byte body could not be read: `REQUEST_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE` or `INVALID_INPUT`.                  |

See [Schemas and validation](../guides/schemas-and-validation.md).

### Results and failures

| Export            | Kind     | What it is                                                                                         |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `ok`              | function | A success carrying a value.                                                                        |
| `err`             | function | A failure carrying an error, usually `catalog.someFailure.create()`.                               |
| `isResult`        | function | Whether an untrusted value, such as another Worker's answer, is a well-formed `Result`.            |
| `Result`          | type     | `Success<T> \| FailureResult<E>`.                                                                  |
| `Success`         | type     | `{ ok: true, value }`.                                                                             |
| `FailureResult`   | type     | `{ ok: false, error }`.                                                                            |
| `defineErrors`    | function | An error catalog: the standard failures and the service's own, each with a factory.                |
| `FailureSchema`   | schema   | Every failure, `{ code, message, retryable, data }`, named `Failure`.                              |
| `resultSchema`    | function | The schema of a `Result` of the given value and error schemas.                                     |
| `standardErrors`  | constant | The catalog of the standard failures alone.                                                        |
| `Failure`         | type     | A failure as every transport carries it.                                                           |
| `FailureData`     | type     | The `data` of a failure whose code declares none: the empty object.                                |
| `ErrorDefinition` | type     | One failure of a catalog: `code`, `status`, `message`, `retryable`, `retryAfter` and `dataSchema`. |
| `ErrorCatalog`    | type     | What every catalog provides: `schema`, `definitions`, `status`, `retryAfter` and `validate`.       |
| `ErrorFactory`    | type     | One failure's `schema`, `create()` and `is()`.                                                     |
| `DefinedErrors`   | type     | What `defineErrors` returns for a set of definitions.                                              |

See [Errors and results](../guides/errors-and-results.md) and
[Standard failures](standard-failures.md).

### Tokens, scopes and discovery

| Export                      | Kind     | What it is                                                                                                         |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `createTokenAuthorization`  | function | Admits a request by its bearer token and a scope, as the API does: a `Result` of the caller.                       |
| `createTokenVerifier`       | function | Verifies an OAuth access token against an issuer's keys and answers its claims; throws on a mismatch.              |
| `projectToken`              | function | The principal a verified token's claims grant, by the claim mapping: a `Result`.                                   |
| `PrincipalSchema`           | schema   | The principal every operation receives: `actorId`, `actorKind`, `organizationId` and `requestId`.                  |
| `Principal`                 | type     | A value of `PrincipalSchema`.                                                                                      |
| `TokenPrincipal`            | type     | What a verified token grants: the principal without its request id, `scopes` and `client`. What `resolve` answers. |
| `TokenPolicy`               | type     | How the application verifies tokens: every option of `tokens`.                                                     |
| `TokenResolutionContext`    | type     | What `resolve` receives besides the token: `env`, `request`, `surface`, `applicationScopes`, `background`.         |
| `TokenScheme`               | type     | `oauth`, `bearer` or `oauth+bearer`.                                                                               |
| `TokenSource`               | type     | Where requests present their token: `authorization` or `cloudflare-access`.                                        |
| `TokenClient`               | type     | The OAuth client a token was issued to: `id`, and `class` `human`, `machine` or `dcr`.                             |
| `TokenClaims`               | type     | The claim mapping: `organization`, `scopes`, `client`, `permissions` and `machineSubject`.                         |
| `TokenAccess`               | type     | What Cloudflare Access tokens grant: `organizationId`, and the scopes of `people` and of each of `services`.       |
| `TokenAlgorithm`            | type     | An algorithm an issuer may sign with.                                                                              |
| `TokenDevelopment`          | type     | The development token's `binding` and `organizationId`.                                                            |
| `projectAccessToken`        | function | The principal a verified Cloudflare Access application token grants under a policy's `access`: a `Result`.         |
| `matchesScopes`             | function | Whether granted scopes admit a list of required scopes, any one or all of them.                                    |
| `ScopeMatch`                | type     | `any` or `all`.                                                                                                    |
| `protectedResourceMetadata` | function | The RFC 9728 metadata of a configured OAuth resource.                                                              |
| `OAuthResource`             | type     | A configured OAuth resource: `audience`, `authorizationServers` and `scopes`.                                      |

See [Authentication and scopes](../guides/authentication-and-scopes.md).

### HTTP

| Export                    | Kind     | What it is                                                                                                            |
| ------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `createHttpHandler`       | function | The application's HTTP handler, `(request, env, background?) => Promise<Response>`, without the Workers runtime.      |
| `HttpOptions`             | type     | What `createHttpHandler` takes besides the application.                                                               |
| `HttpTransport`           | type     | A protocol served at one path beside the operations, such as MCP.                                                     |
| `TransportContext`        | type     | What a transport receives for one admitted request.                                                                   |
| `HttpRoute`               | type     | A plain route or a page: `(request, env, context) => Promise<Response>`.                                              |
| `HttpMiddleware`          | type     | Request middleware: `(request, env, context, next) => Promise<Response>`.                                             |
| `RouteContext`            | type     | What a plain route receives: `requestId`, `fail` and `waitUntil`.                                                     |
| `createHttpRouteResolver` | function | The router: `match(method, path)` and `ownsPath(path)`.                                                               |
| `HttpRouteDefinition`     | type     | What the router reads of a definition: its `http` method and path.                                                    |
| `HttpRouteMatch`          | type     | A matched route: its `definition` and its decoded `parameters`.                                                       |
| `readBodyText`            | function | Reads a body as UTF-8 within a byte limit: a `Result`.                                                                |
| `readBodyBytes`           | function | Reads a body's bytes within a byte limit, chunked bodies included: a `Result`.                                        |
| `BodyReadOptions`         | type     | `maxBytes`, and an optional `signal`.                                                                                 |
| `HttpBodyFailure`         | type     | A body that could not be read: `HTTP_BODY_INVALID`, with its `reason`.                                                |
| `HttpBodyFailureReason`   | type     | `too_large`, `invalid_length`, `invalid_json`, `invalid_utf8`, `unexpected_content_type`, `aborted` or `read_failed`. |
| `readJsonResponse`        | function | Reads another service's JSON answer within a byte limit; `null` for a `204` or `205`.                                 |
| `readJsonBody`            | function | Reads a JSON body within a byte limit, as `unknown` for a schema to check.                                            |
| `retryAfterSeconds`       | function | The seconds a `Retry-After` value asks to wait, at most an hour by default; `undefined` when it is unreadable.        |
| `isJsonMediaType`         | function | Whether a content type is `application/json` or a `+json` type.                                                       |
| `createOpenApi`           | function | The application's OpenAPI 3.1 document.                                                                               |
| `createRpcOpenApi`        | function | The OpenAPI 3.1 document of the operations it serves over native RPC, which callers type their bindings from.         |

See [Routes](../guides/routes.md) and [Worker composition](../guides/worker-composition.md).

### Telemetry

| Export                 | Kind     | What it is                                                                                       |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `reportUnexpected`     | function | Logs an unexpected error by its safe description, `maximus.unexpected`, and tells the observers. |
| `Observer`             | type     | Receives execution and admission observations and unexpected errors.                             |
| `TelemetryConfig`      | type     | Whether telemetry is on, for every environment or per environment, the observers, and `traceId`. |
| `ExecutionObservation` | type     | What an observer learns of one operation call. Never its input or output.                        |
| `AdmissionObservation` | type     | What an observer learns of a request refused before any operation ran.                           |
| `BackgroundContext`    | type     | Where work that outlives the answer goes: `waitUntil`.                                           |

See [Observability](../guides/observability.md).

## @arbol-ai/maximus/schemas

The schema vocabulary without the rest of the core: what a contract module that a browser imports uses.

| Export                   | Kind           | What it is                                                                                                      |
| ------------------------ | -------------- | --------------------------------------------------------------------------------------------------------------- |
| `Type`, `t`              | constant       | TypeBox's schema builder.                                                                                       |
| `Static`                 | type           | The TypeScript type of a schema's values.                                                                       |
| `TSchema`                | type           | Any TypeBox schema.                                                                                             |
| `StaticDecode`           | type           | A schema's decoded value: what a handler receives from an input with codecs.                                    |
| `parseInput`             | function       | Checks a value against a schema without decoding it: a `Result` of the value, or `INVALID_INPUT`.               |
| `parseSchema`            | function       | Checks a value against a schema and returns it typed, or throws a `TypeError` that names no value.              |
| `decodeInput`            | function       | Decodes input as an operation does: a `Result` of the value, or `INVALID_INPUT` with its issues.                |
| `decodeSchema`           | function       | Decodes input with its defaults and codecs, or throws `SchemaValidationError`.                                  |
| `InputIssue`             | type           | One issue of a refused input: its JSON Pointer `path` and a `message` that never holds the value.               |
| `EmptyInputSchema`       | schema         | The empty strict object.                                                                                        |
| `OrganizationIdSchema`   | schema         | An organization id, named `OrganizationId`.                                                                     |
| `UuidSchema`             | schema         | A lowercase UUID of version 1 to 8, named `Uuid`.                                                               |
| `literalUnion`           | function       | A union of literals: `literalUnion(['open', 'done'])`.                                                          |
| `defaultSchema`          | function       | The schema with a default, so the field may be left out on the wire.                                            |
| `stripObject`            | function       | A strict object that a read drops unknown keys from instead of refusing them.                                   |
| `strictObject`           | function       | The object, refusing unknown keys even where a read strips them.                                                |
| `looseObject`            | function       | The object, admitting and keeping unknown keys.                                                                 |
| `extendObject`           | function       | The object with more properties, keeping how it treats unknown keys.                                            |
| `normalizeSchema`        | function       | Normalizes a value before its checks, such as trimming a string.                                                |
| `transformSchema`        | function       | Transforms a value once it is checked.                                                                          |
| `pipeSchema`             | function       | Reads a value as one schema, then checks and decodes the result as another.                                     |
| `inspectSchema`          | function       | Refuses a value the schema admits with the issues an inspection adds.                                           |
| `refineSchema`           | function       | Refuses a value the schema admits when a predicate rejects it.                                                  |
| `urlSchema`              | function       | A URL whose protocol, and optionally hostname, match the given patterns.                                        |
| `inputSchema`            | function       | Compiles a schema's codecs into one input schema; an input that uses a codec requires it.                       |
| `SchemaValidationError`  | class          | Every issue of a refused value, as `readSchema` throws it.                                                      |
| `SchemaInput`            | type           | The type a schema accepts on the wire.                                                                          |
| `SchemaIssue`            | type           | One refused field: `code`, `message` and `path`.                                                                |
| `checkSchema`            | function       | Reads untrusted data, such as a stored record, through its schema: `{ success, data }` or `{ success, error }`. |
| `readSchema`             | function       | `checkSchema`, throwing its `SchemaValidationError` on refusal.                                                 |
| `Checked`                | type           | What `checkSchema` answers.                                                                                     |
| `AttachmentOutputSchema` | schema         | The output of a route that answers a file.                                                                      |
| `Attachment`             | type           | A file a route answers with.                                                                                    |
| `Page`                   | function, type | The output of a list of an item, and one page as a handler returns it.                                          |
| `PageInfoSchema`         | schema         | A list's neighboring pages, named `PageInfo`.                                                                   |
| `PageQueryFields`        | constant       | A list's query fields: `cursor`, `direction` and `limit`.                                                       |
| `pageLimit`              | function       | A list's `limit` field with its own maximum and default.                                                        |
| `DeletedObjectSchema`    | schema         | What a delete answers, named `DeletedObject`.                                                                   |
| `EmailAddressSchema`     | schema         | An email address, named `EmailAddress`.                                                                         |
| `HexColorSchema`         | schema         | A `#rrggbb` color, named `HexColor`.                                                                            |
| `HttpsUrlSchema`         | schema         | An HTTPS URL, named `HttpsUrl`.                                                                                 |
| `NamedReferenceSchema`   | schema         | Another resource by its `id` and `name`, named `NamedReference`.                                                |
| `PhoneNumberSchema`      | schema         | A phone number in E.164 format, named `PhoneNumber`.                                                            |
| `PostalAddressSchema`    | schema         | A postal address shaped as FHIR `Address`, named `PostalAddress`.                                               |
| `SignedUrlSchema`        | schema         | A link that grants access until it expires, named `SignedUrl`.                                                  |
| `DeletedObject`          | type           | A value of `DeletedObjectSchema`.                                                                               |
| `NamedReference`         | type           | A value of `NamedReferenceSchema`.                                                                              |
| `PostalAddress`          | type           | A value of `PostalAddressSchema`.                                                                               |
| `SignedUrl`              | type           | A value of `SignedUrlSchema`.                                                                                   |
| `PageInfo`               | type           | A value of `PageInfoSchema`.                                                                                    |
| `PageQuery`              | type           | The list query a handler receives.                                                                              |
| `TPage`                  | type           | The TypeBox type of a `Page` schema.                                                                            |

## @arbol-ai/maximus/errors

Error catalogs, for code that builds or reads failures without the rest of the core.

| Export            | Kind     | What it is                                                                          |
| ----------------- | -------- | ----------------------------------------------------------------------------------- |
| `FailureData`     | type     | The `data` of a failure whose code declares none.                                   |
| `Failure`         | type     | A failure: `code`, `message`, `retryable` and `data`.                               |
| `ErrorDefinition` | type     | One failure of a catalog.                                                           |
| `FailureSchema`   | schema   | Every failure, named `Failure`.                                                     |
| `CreateArguments` | type     | What a failure's `create()` takes: the data its definition declares.                |
| `ErrorFactory`    | type     | One failure's `schema`, `create()` and `is()`.                                      |
| `ErrorCatalog`    | type     | What every catalog provides.                                                        |
| `DefinedErrors`   | type     | What `defineErrors` returns.                                                        |
| `defineErrors`    | function | An error catalog: the standard failures and the service's own.                      |
| `standardErrors`  | constant | The catalog of the standard failures alone.                                         |
| `resultSchema`    | function | The schema of a `Result`.                                                           |
| `isRequestId`     | function | Whether a value is a request id a failure may carry: a UUID or a Cloudflare ray id. |

## @arbol-ai/maximus/failures

The standard failures as plain data, with no runtime and no schema library, for a dispatcher that presents
them, such as an API gateway.

| Export              | Kind     | What it is                                                                                                    |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `StandardFailure`   | type     | One standard failure: `code`, `status`, `message`, `retryable` and `retryAfter`.                              |
| `STANDARD_FAILURES` | constant | Every standard failure, by the name `standardErrors` gives it. See [Standard failures](standard-failures.md). |

## @arbol-ai/maximus/body

Bounded body readers: the root's, alone.

| Export                  | Kind     | What it is                                                                  |
| ----------------------- | -------- | --------------------------------------------------------------------------- |
| `readBodyText`          | function | Reads a body as UTF-8 within a byte limit: a `Result`.                      |
| `readBodyBytes`         | function | Reads a body's bytes within a byte limit: a `Result`.                       |
| `BodyReadOptions`       | type     | `maxBytes`, and an optional `signal`.                                       |
| `HttpBodyFailure`       | type     | A body that could not be read: `HTTP_BODY_INVALID`, with its `reason`.      |
| `HttpBodyFailureReason` | type     | Why a body could not be read.                                               |
| `readJsonResponse`      | function | Reads another service's JSON answer within a byte limit.                    |
| `readJsonBody`          | function | Reads a JSON body within a byte limit.                                      |
| `retryAfterSeconds`     | function | The seconds a `Retry-After` value asks to wait, at most an hour by default. |
| `isJsonMediaType`       | function | Whether a content type is `application/json` or a `+json` type.             |

## @arbol-ai/maximus/webhooks

Webhook signature verification on a request's raw bytes. See
[Worker composition](../guides/worker-composition.md#verify-a-webhook).

| Export                          | Kind     | What it is                                                                            |
| ------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `WEBHOOK_SIGNATURE_FAILURES`    | constant | The reasons a signature is refused: `missing`, `malformed`, `expired` and `mismatch`. |
| `WebhookSignatureFailureReason` | type     | One of those reasons.                                                                 |
| `WebhookSignatureFailure`       | type     | A refused signature: `WEBHOOK_SIGNATURE_INVALID`, with its `reason`.                  |
| `webhookSignatureFailure`       | function | The failure for a reason.                                                             |
| `DEFAULT_TOLERANCE_SECONDS`     | constant | 300: how far a signed timestamp may be from the current time, either way.             |
| `MAX_SIGNATURES`                | constant | 8: the most signatures one header may carry.                                          |
| `verifyHmacSignature`           | function | Verifies an HMAC-SHA256 of the body in one header, hex or base64.                     |
| `verifyTimestampedSignature`    | function | Verifies a `t=<seconds>,v1=<hex>` header that signs `<t>.<body>`.                     |
| `verifyStandardWebhook`         | function | Verifies a Standard Webhooks delivery, `webhook-*` or `svix-*` headers.               |

## @arbol-ai/maximus/http-paths

Route templates and the router, alone.

| Export                    | Kind     | What it is                                                                                         |
| ------------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `isInputHeaderName`       | function | Whether a byte route may read an input field from this header: not an authority or framing header. |
| `operationPathParameters` | function | The parameters of a versioned path template; throws for a template that is not one.                |
| `decodePathParameter`     | function | One path segment, decoded, or `null` when it cannot be a parameter.                                |
| `isPathParameterValue`    | function | Whether a value can be a path parameter: one non-empty segment once encoded.                       |
| `HttpRouteDefinition`     | type     | What the router reads of a definition.                                                             |
| `HttpRouteMatch`          | type     | A matched route and its decoded parameters.                                                        |
| `createHttpRouteResolver` | function | The router: `match(method, path)` and `ownsPath(path)`.                                            |

## @arbol-ai/maximus/projection

For a gateway that builds MCP tools, CLI commands and clients from services' OpenAPI documents, so the
service, the gateway and its clients agree on names without coordinating.

| Export                  | Kind     | What it is                                                                     |
| ----------------------- | -------- | ------------------------------------------------------------------------------ |
| `queryKind`             | function | How one input field travels in a query string, or `null` when it cannot.       |
| `QueryKind`             | type     | `string`, `integer`, `number`, `boolean` or `list`.                            |
| `SchemaResolver`        | type     | Resolves a local `$ref` of a bundled document.                                 |
| `ProjectedName`         | type     | A resource and the verb that acts on it.                                       |
| `kebab`                 | function | A camelCase name in kebab-case.                                                |
| `snake`                 | function | A camelCase or kebab-case name in snake_case.                                  |
| `permissionDescription` | function | What a scope lets a person do, in words: `notes:notes:write` is `Write notes`. |
| `mcpToolName`           | function | A tool name portable across MCP clients and model providers.                   |

## @arbol-ai/maximus/diagnostics

Diagnostics and request correlation, for code that runs beside the operations, such as a Durable Object or
a queue consumer. See [Observability](../guides/observability.md).

| Export                 | Kind     | What it is                                                                                             |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `withDiagnostics`      | function | Runs a callback, and everything it calls, with diagnostics on or off and the given observers.          |
| `diagnosticsEnabled`   | function | Whether the current call runs with diagnostics on.                                                     |
| `telemetryEnabled`     | function | Whether a telemetry configuration is on for an environment.                                            |
| `reportUnexpected`     | function | Logs an unexpected error by its safe description and tells the observers.                              |
| `recordExecution`      | function | Hands the observation of one operation call to the observers, as background work.                      |
| `TelemetryConfig`      | type     | Whether telemetry is on, the observers, and `traceId`, which reads the active span's trace id.         |
| `Observer`             | type     | Receives execution and admission observations and unexpected errors.                                   |
| `ExecutionObservation` | type     | What an observer learns of one operation call.                                                         |
| `BackgroundContext`    | type     | `waitUntil`.                                                                                           |
| `createDiagnostics`    | function | An error describer, `describeError` and `safeErrorName`, that never reads a message.                   |
| `ErrorDescription`     | type     | What a description says of an error: its name, its causes' names, its issue count and stack locations. |
| `createRequestId`      | function | A new request id, or a trusted edge's ray id.                                                          |
| `durableCorrelation`   | function | The correlation to persist with durable work: a request id and the originating `traceparent`.          |
| `isRequestId`          | function | Whether a value is a UUID or a Cloudflare ray id.                                                      |
| `parseTraceParent`     | function | Reads a W3C `traceparent` header of version 00.                                                        |
| `DurableCorrelation`   | type     | What `durableCorrelation` answers.                                                                     |
| `TraceParent`          | type     | What `parseTraceParent` answers: the trace id, the parent span id and the sampled flag.                |

## @arbol-ai/maximus/internals

The interface transports and adapters build on, and tests use. Applications use routes, tools and the
builder instead.

| Export                    | Kind     | What it is                                                                                  |
| ------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `executeOperation`        | function | Runs one operation through the shared execution path, as every transport does.              |
| `defineApp`               | function | Checks an application assembled without the builder against every rule `.build()` enforces. |
| `composeOperations`       | function | Joins groups of operations, refusing a name declared twice.                                 |
| `operation`               | function | Declares one operation on its own, keeping its literal types.                               |
| `operationScopes`         | function | An operation's scopes, as a list.                                                           |
| `AppManifest`             | type     | A built application.                                                                        |
| `OperationShape`          | type     | An operation as an application holds it.                                                    |
| `Invocation`              | type     | What preparation and middleware start from.                                                 |
| `InvocationAuthority`     | type     | What admission verified about a call's token.                                               |
| `OperationMiddleware`     | type     | `(context, next) => Promise<Result>`.                                                       |
| `HttpTransport`           | type     | A protocol served at one path beside the operations.                                        |
| `TransportContext`        | type     | What a transport receives for one admitted request.                                         |
| `HttpOptions`             | type     | What `createHttpHandler` takes besides the application.                                     |
| `telemetryEnabled`        | function | Whether a telemetry configuration is on for an environment.                                 |
| `recordExecution`         | function | Hands the observation of one operation call to the observers.                               |
| `withDiagnostics`         | function | Runs a callback with diagnostics on or off and the given observers.                         |
| `TelemetryConfig`         | type     | Whether telemetry is on, the observers, and `traceId`.                                      |
| `BackgroundContext`       | type     | `waitUntil`.                                                                                |
| `createHttpRouteResolver` | function | The router.                                                                                 |
| `HttpRouteDefinition`     | type     | What the router reads of a definition.                                                      |
| `HttpRouteMatch`          | type     | A matched route and its decoded parameters.                                                 |

## @arbol-ai/maximus/workers

The Worker: it imports `cloudflare:workers`, so only a Worker loads it. See
[Worker composition](../guides/worker-composition.md) and [Worker RPC](../guides/worker-rpc.md).

| Export                | Kind     | What it is                                                                                          |
| --------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `WorkerAssetsOptions` | type     | The `assets` option: `binding`, `pages`, `files`, `immutablePrefixes`, `headers` and `development`. |
| `RpcMethods`          | type     | `RpcMethods<typeof app.operations>`: the methods the RPC entrypoint serves.                         |
| `WorkerRuntime`       | type     | What `createWorker` returns: `handler`, `entrypoint`, `service` and `durableObject`.                |
| `WorkerOptions`       | type     | What `createWorker` takes: `handlers`, `transports`, `http`, `assets` and `routes`.                 |
| `createWorker`        | function | Serves an application as a Worker.                                                                  |
| `credentials`         | function | Prepares one organization's credential from its own store, for a `.derive()`.                       |

## @arbol-ai/maximus/mcp

| Export | Kind     | What it is                                                                                                                        |
| ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `mcp`  | function | The MCP transport, `mcp({ path? })`, at `/mcp` by default. The MCP SDK loads with its first request. See [MCP](../guides/mcp.md). |

## @arbol-ai/maximus/analytics

An observer that records one allowlisted event per operation call in a store you provide. See
[Observability](../guides/observability.md).

| Export                 | Kind     | What it is                                                                                             |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `ExecutionEventSchema` | schema   | An analytics event: who called which operation, over which surface, how it ended and how long it took. |
| `ExecutionEvent`       | type     | A value of `ExecutionEventSchema`.                                                                     |
| `AnalyticsOptions`     | type     | What `analytics()` takes: `record`, which keeps an event in your store, `enabled` and `actor`.         |
| `analytics`            | function | The observer.                                                                                          |

## @arbol-ai/maximus/postgres

Short tenant-scoped transactions with `pg`, an optional peer dependency: install `pg` to use this entry.
Nothing else in Maximus loads it, and it depends on nothing else in Maximus. See
[Postgres transactions](../guides/postgres.md).

| Export                       | Kind     | What it is                                                                                                    |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `withTenantTransaction`      | function | Runs work in one transaction for one organization, within its time budgets: a result or a classified failure. |
| `TenantContext`              | type     | The organization a transaction works for.                                                                     |
| `TransactionOptions`         | type     | The time budgets, isolation level and database-only retries of a transaction.                                 |
| `TransactionResult`          | type     | The work's value, or a classified failure.                                                                    |
| `classifyTransactionFailure` | function | Classifies a failure by its stage and its SQLSTATE, never by its message.                                     |
| `TransactionFailure`         | type     | A classified failure.                                                                                         |
| `TransactionStage`           | type     | `connect`, `begin`, `configure`, `work` or `commit`.                                                          |

## @arbol-ai/maximus/testing

| Export           | Kind     | What it is                                                                                                                                                                                             |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `verifyContract` | function | Fetches a running service's `/openapi.json` and `/openapi.yaml` from an origin, checks that they agree, and answers its paths and operations. For tests and smoke checks; never import it in a Worker. |

## @arbol-ai/maximus/oxfmt and @arbol-ai/maximus/oxlint

| Export    | Kind     | What it is                                                                                                |
| --------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `default` | constant | The format preset, in `/oxfmt`, and the lint preset, Ultracite's with Maximus's guardrails, in `/oxlint`. |

`maximus()` brings both when the configuration sets no `fmt` or `lint` of its own. See
[Lint and format](../guides/lint-and-format.md).

## @arbol-ai/maximus/project

The Worker a project's files make, which `.maximus/worker.ts` builds. It imports `cloudflare:workers`.

| Export                | Kind     | What it is                                                                                      |
| --------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `PageMethod`          | type     | The methods a page answers: `GET` (which answers `HEAD` too), `POST`, `PUT`, `PATCH`, `DELETE`. |
| `ProjectCron`         | type     | A cron module: its schedule and its handler.                                                    |
| `ProjectEvents`       | type     | A project's `crons`, `queues` and `email` handlers.                                             |
| `ProjectModules`      | type     | What a project adds to a Worker: its events and its `pages`.                                    |
| `ProjectPage`         | type     | A page: an `HttpRoute` that answers `GET`, or a record of one per method, `{ POST: receive }`.  |
| `createProjectWorker` | function | `createWorker`, with a project's pages and event handlers.                                      |

## @arbol-ai/maximus/config

What a project's files declare, and what the generated `.maximus/` modules bind them to the application
with. It loads no Workers or build code.

| Export                      | Kind     | What it is                                                                                     |
| --------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `bindContext`               | function | Prepares every call's context with `context.ts`'s declaration.                                 |
| `bindRoute`                 | function | Binds a `defineHandler` declaration under the path, method and derived name `prepare` gives.   |
| `bindTool`                  | function | Binds a `defineTool` declaration under the name its file gives.                                |
| `routeName`                 | function | A route's derived operation name: `POST /v1/tasks/{taskId}/complete` is `completeTask`.        |
| `toolName`                  | function | A tool's operation name: `summarize-tasks` is `summarizeTasks`.                                |
| `ToolMcpName`               | type     | A tool's MCP name: `summarize-tasks` is `summarize_tasks`.                                     |
| `ToolName`                  | type     | `toolName`, in the type.                                                                       |
| `RequestMiddlewareModule`   | type     | What `defineMiddleware` returns.                                                               |
| `defineMiddleware`          | function | A file of `middleware/` that wraps every HTTP request, before token admission.                 |
| `OperationMiddlewareModule` | type     | What `defineOperationMiddleware` returns.                                                      |
| `defineOperationMiddleware` | function | A file of `middleware/` that runs around every operation, after admission, on every transport. |
| `ProjectMiddleware`         | type     | What a file of `middleware/` default-exports.                                                  |
| `collectMiddleware`         | function | Splits the middleware modules by phase, in their order.                                        |
| `useProjectMiddleware`      | function | Applies the project's operation middleware to its base.                                        |
| `checkProjectPipeline`      | function | Refuses an operation that does not run the project's middleware.                               |

## @arbol-ai/maximus/vite

`maximus()`, the project's configuration: one `vite.config.ts` configures the application and its
Cloudflare Worker. It runs in Node, under Vite+, and takes `@cloudflare/vite-plugin`, `cf` and `vite` as
peers, which a project installs. `auth0()` and `cloudflareAccess()` state the `tokens` option for those
providers. See [Configuration](configuration.md).

| Export                    | Kind     | What it is                                                                                                                                          |
| ------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MaximusOptions`          | type     | What `maximus()` takes: the application's options and the Worker's settings, by Cloudflare's names.                                                 |
| `Phase`                   | type     | `development` under `vp dev`, `production` for every build.                                                                                         |
| `TokenOptions`            | type     | The `tokens` option: the token policy less what `auth.ts` states. Its audience defaults to the origin; `development` is the token `vp dev` accepts. |
| `ServiceOptions`          | type     | An entry of the `services` option: the `worker` a service binding reaches and the `openapi` document that types it.                                 |
| `WebAppOptions`           | type     | The `webApp` option: the headers of a web app's pages and files.                                                                                    |
| `auth0`                   | function | The `tokens` options of an API whose access tokens Auth0 issues: its issuer, from its domain or domains, its audience and its algorithms.           |
| `cloudflareAccess`        | function | The `tokens` options of an application behind Cloudflare Access: the Access source, the team's issuer and keys, the AUD tag and what callers hold.  |
| `Auth0Algorithm`          | type     | `RS256`, `RS512` or `PS256`: what Auth0 signs an API's tokens with that a JWKS can verify.                                                          |
| `Auth0Options`            | type     | What `auth0()` takes: `domain`, `audience` and `algorithms`.                                                                                        |
| `CloudflareAccessOptions` | type     | What `cloudflareAccess()` takes: `team`, `aud`, `organizationId` and `scopes`.                                                                      |
| `maximus`                 | function | The plugin: prepares the project, brings the lint and format presets, and runs Cloudflare's Vite plugin.                                            |

## Binaries and files

| Binary    | What it is                                                                           |
| --------- | ------------------------------------------------------------------------------------ |
| `maximus` | The CLI: `init`, `gen route`, `gen tool`, `skills` and `prepare`. See [CLI](cli.md). |

`@arbol-ai/maximus` also ships the Maximus skill for coding agents in `skills/maximus/`, which
`maximus skills` links into a project, and the templates `maximus init` writes projects from.
