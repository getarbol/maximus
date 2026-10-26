# Package exports

Maximus is one package, `@arbol-ai/maximus`. Every entry point and what it exports is below. Import
from the narrowest entry you need: the package is side-effect free, a bundle carries only the entries
it imports, and the runtime-free entries keep browser and gateway bundles small.

## @arbol-ai/maximus

The root: the core. Safe to import in a browser, but brings the whole core; prefer `/schemas` there.

| Purpose                 | Exports                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Builder                 | `maximus`, types `ApplicationBuilder`, `ApplicationConfiguration` (what `maximus()` takes)                                                                                                                                                                                                                              |
| Schemas                 | `t` (also `Type`), types `Static`, `TSchema`; `EmptyInputSchema`, `OrganizationIdSchema`, `UuidSchema`, `AttachmentOutputSchema`, type `Attachment`; `parseInput`, `parseSchema`                                                                                                                                        |
| Lists                   | `Page` (also the type `Page<Item>`), `PageInfoSchema`, `PageQueryFields`, `pageLimit`; types `PageInfo`, `PageQuery`, `TPage`. See [Lists](../guides/schemas-and-validation.md#lists)                                                                                                                                   |
| Shared schemas          | `EmailAddressSchema`, `PhoneNumberSchema`, `HttpsUrlSchema`, `HexColorSchema`, `DeletedObjectSchema`, `SignedUrlSchema`, `NamedReferenceSchema`, `PostalAddressSchema`; types `DeletedObject`, `SignedUrl`, `NamedReference`, `PostalAddress`. See [Shared schemas](../guides/schemas-and-validation.md#shared-schemas) |
| Results and failures    | `ok`, `err`, `isResult`, types `Result`, `Success`, `FailureResult`; `defineErrors`, `standardErrors`, `resultSchema`, `FailureSchema`; types `Failure`, `FailureData`, `ErrorDefinition`, `ErrorCatalog`, `ErrorFactory`, `DefinedErrors` (what `defineErrors` returns)                                                |
| Tokens                  | `createTokenVerifier`, `createTokenAuthorization`, `projectToken`, `PrincipalSchema`; types `Principal`, `TokenPrincipal`, `TokenPolicy`, `TokenClaims`, `TokenAlgorithm`, `TokenDevelopment`, `TokenResolutionContext`, `TokenScheme`, `TokenClient`                                                                   |
| Operations              | `operationScopes`, `operationMatchesScopes`, `matchesScopes`, `isPublicOperation`; types `AppManifest`, `OperationShape`, `OperationScope`, `Exposure`, `OperationMiddleware`, `Invocation`, `InvocationAuthority`, `ScopeMatch`                                                                                        |
| HTTP                    | `createHttpHandler`, `createHttpRouteResolver`; types `HttpOptions` (what `createHttpHandler` takes), `HttpRoute`, `RouteContext`, `HttpTransport`, `TransportContext`, `HttpRouteDefinition`, `HttpRouteMatch`, `BinaryBody`                                                                                           |
| OpenAPI                 | `createOpenApi`; `protectedResourceMetadata`, type `OAuthResource`                                                                                                                                                                                                                                                      |
| MCP configuration types | `McpConfiguration`, `McpGuide`, `McpSkill`                                                                                                                                                                                                                                                                              |
| Bounded bodies          | `readBodyText`, `readBodyBytes`, `readJsonBody`, `readJsonResponse`, `retryAfterSeconds`, `isJsonMediaType`; types `BodyReadOptions`, `HttpBodyFailure`, `HttpBodyFailureReason`                                                                                                                                        |
| Telemetry               | `reportUnexpected`; types `Observer`, `TelemetryConfig`, `ExecutionObservation`, `AdmissionObservation`, `BackgroundContext`                                                                                                                                                                                            |

### Subpath entries

| Entry                           | Exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Runtime-free           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `@arbol-ai/maximus/schemas`     | `t`, `Type`, types `Static`, `StaticDecode`, `TSchema`; `parseInput`, `parseSchema`, `decodeInput`, `decodeSchema`, `checkSchema`, `readSchema`, `SchemaValidationError`, types `SchemaInput`, `SchemaIssue`, `Checked`, `InputIssue`; codecs `inputSchema`, `defaultSchema`, `normalizeSchema`, `transformSchema`, `pipeSchema`, `inspectSchema`, `refineSchema`, `urlSchema`, `literalUnion`, `stripObject`, `strictObject`, `looseObject`, `extendObject`; `EmptyInputSchema`, `OrganizationIdSchema`, `UuidSchema`, `AttachmentOutputSchema`; lists `Page`, `PageInfoSchema`, `PageQueryFields`, `pageLimit`, types `PageInfo`, `PageQuery`, `TPage`; the shared schemas `EmailAddressSchema`, `PhoneNumberSchema`, `HttpsUrlSchema`, `HexColorSchema`, `DeletedObjectSchema`, `SignedUrlSchema`, `NamedReferenceSchema`, `PostalAddressSchema`, types `DeletedObject`, `SignedUrl`, `NamedReference`, `PostalAddress` | No Worker runtime      |
| `@arbol-ai/maximus/errors`      | `defineErrors`, `standardErrors`, `resultSchema`, `FailureSchema`, `isRequestId`; types `Failure`, `FailureData`, `ErrorDefinition`, `ErrorCatalog`, `ErrorFactory`, `DefinedErrors`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | No Worker runtime      |
| `@arbol-ai/maximus/failures`    | `STANDARD_FAILURES`, type `StandardFailure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Yes: no schema library |
| `@arbol-ai/maximus/body`        | `readBodyText`, `readBodyBytes`, `readJsonBody`, `readJsonResponse`, `retryAfterSeconds`, `isJsonMediaType`; types `BodyReadOptions`, `HttpBodyFailure`, `HttpBodyFailureReason`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Yes                    |
| `@arbol-ai/maximus/webhooks`    | `verifyHmacSignature` (HMAC-SHA256 of the raw body, hex or base64), `verifyTimestampedSignature` (`t=…,v1=…`), `verifyStandardWebhook` (Standard Webhooks, `webhook-*` or `svix-*`), `webhookSignatureFailure`, `WEBHOOK_SIGNATURE_FAILURES`, `DEFAULT_TOLERANCE_SECONDS`, `MAX_SIGNATURES`; types `WebhookSignatureFailure`, `WebhookSignatureFailureReason`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Yes                    |
| `@arbol-ai/maximus/http-paths`  | `createHttpRouteResolver`, `operationPathParameters`, `decodePathParameter`, `isPathParameterValue`; types `HttpRouteDefinition`, `HttpRouteMatch`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Yes                    |
| `@arbol-ai/maximus/projection`  | For a gateway that builds MCP tools, CLI commands and clients from services' OpenAPI documents: `mcpToolName`, `kebab`, `snake`, `permissionDescription`, `queryKind`; types `QueryKind`, `SchemaResolver`, `ProjectedName`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Yes                    |
| `@arbol-ai/maximus/diagnostics` | `withDiagnostics`, `diagnosticsEnabled`, `telemetryEnabled`, `reportUnexpected`, `recordExecution`, `createDiagnostics`, `isRequestId`, `createRequestId`, `parseTraceParent`, `durableCorrelation`; types `TelemetryConfig`, `Observer`, `ExecutionObservation`, `BackgroundContext`, `TraceParent`, `DurableCorrelation`, `ErrorDescription`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | No                     |
| `@arbol-ai/maximus/internals`   | Adapter SPI: `executeOperation`, `defineApp`, `composeOperations`, `operation`, `operationScopes`, `createHttpRouteResolver`, `telemetryEnabled`, `recordExecution`, `withDiagnostics`; types `AppManifest`, `OperationShape`, `Invocation`, `InvocationAuthority`, `OperationMiddleware`, `HttpTransport`, `TransportContext`, `HttpOptions`, `TelemetryConfig`, `BackgroundContext`, `HttpRouteDefinition`, `HttpRouteMatch`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | No                     |

`/internals` serves transport adapters and tests. Applications use the builder.

## @arbol-ai/maximus/workers

`createWorker`, `credentials`; types `WorkerOptions` (what `createWorker` takes), `WorkerRuntime`,
`RpcMethods`, `WorkerAssetsOptions`. Imports `cloudflare:workers`, so only a Worker bundle loads it.

## @arbol-ai/maximus/project and @arbol-ai/maximus/vite

`/project` exports `createProjectWorker` and types `ProjectModules`, `ProjectCron`, `ProjectEvents`.
It is Workers-only and composes discovered pages and background handlers through the existing runtime.
`/vite` exports the Node-only `maximusProject()` plugin; Vite is an optional peer, never a runtime
dependency. See [Project structure](../guides/project-structure.md).

## @arbol-ai/maximus/mcp

`mcp`: the Streamable HTTP transport.

## @arbol-ai/maximus/client

`createClient`; types `Envelope`, `ClientOptions`, `ClientFailure`, `CallOptions`, `BinaryCallOptions`,
`AppClientContract`, `ClientManifest`, `ResponseMode`, `OperationName`, `ReadOperationName`,
`OperationInput`, `OperationOutput`. Imports the application only as a type.

## @arbol-ai/maximus/analytics

`analytics`, `ExecutionEventSchema`; types `ExecutionEvent`, `ExecutionSink`.

## @arbol-ai/maximus/testing

`verifyContract(fetch, origin)`: fetches a running service's `/openapi.json` and its YAML twin and
checks that they agree. For tests and smoke checks; never import it in a Worker.

## @arbol-ai/maximus/oxlint and @arbol-ai/maximus/oxfmt

Lint and format presets: Ultracite's, plus Maximus's guardrails (the `maximus` oxlint plugin, and
restricted imports and properties). They need the optional peers `oxlint`, `oxfmt` and `ultracite`.
See [Lint and format](../guides/lint-and-format.md).

```ts
// oxlint.config.ts
export { default } from '@arbol-ai/maximus/oxlint';
```

## @arbol-ai/maximus/postgres

Short tenant-scoped transactions with `pg`, an optional peer dependency: install `pg` to use this
entry; nothing else in Maximus loads it.

| Exports                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `withTenantTransaction`, `classifyTransactionFailure`; types `TenantContext`, `TransactionOptions`, `TransactionResult`, `TransactionFailure`, `TransactionStage` |

It does not install row-level security: your queries filter by the trusted organization and use
composite keys. See the [Postgres guide](../guides/postgres.md).

## Binaries and files

| Binary    | Purpose                                                                    |
| --------- | -------------------------------------------------------------------------- |
| `maximus` | The CLI: check, run, deploy and scaffold. See the [CLI reference](cli.md). |

The package also ships the Maximus Agent Skill in `skills/maximus/` and the `maximus init` templates.
