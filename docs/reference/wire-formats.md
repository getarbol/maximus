# Wire formats reference

What Maximus sends and accepts on each transport, and the documents it produces.

## HTTP

### Envelopes

Every operation response body is one of:

```ts
type Success<T> = { success: true; data: T; error: null; metadata: { requestId: string } };
type Refusal = { success: false; data: null; error: Failure; metadata: { requestId: string } };
type Failure = { code: string; message: string; retryable: boolean; data: object };
```

Attachment downloads answer the raw bytes instead (see below). Plain routes, mounts, assets and the
discovery endpoints answer their own formats. The OpenAPI document names `metadata`
`ResponseMetadata` and the refusal `FailureResponse`.

### Lists

A list declared with `PageQueryFields` and `Page(item, { $id })` takes these query parameters:

| Parameter   | Schema                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| `cursor`    | Optional string: the opaque cursor from `pageInfo`; absent for the first page.                                |
| `direction` | `forward` or `backward`, default `forward`: the direction from the cursor in the stable keyset order.         |
| `limit`     | Integer from 1 to 100, default 25 (another maximum and default with `pageLimit`): the most items in one page. |

and answers `data`:

```ts
type Page<Item> = { object: 'list'; data: Item[]; pageInfo: PageInfo }; // component <$id>
type PageInfo = {
  hasNextPage: boolean; // a later page exists in the current ordering
  hasPreviousPage: boolean; // an earlier page exists in the current ordering
  nextCursor: string | null; // null when there is no next page
  previousCursor: string | null; // null when there is no previous page
}; // component PageInfo
```

Both are strict: no other property is accepted. There is no page number, offset or total.

### Headers

| Header                   | On                                                              | Value                                                                                                                    |
| ------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `x-request-id`           | Every response                                                  | The request's UUID.                                                                                                      |
| `cache-control`          | Every response                                                  | `private, no-store`, unless a plain route, mount, fallback or asset sets its own.                                        |
| `x-content-type-options` | Every response                                                  | `nosniff`                                                                                                                |
| `server-timing`          | Every response                                                  | `total;dur=<ms>`                                                                                                         |
| `content-type`           | Envelopes                                                       | `application/json`                                                                                                       |
| `www-authenticate`       | `401`                                                           | `Bearer resource_metadata="<url>"`, or `Bearer` (bearer scheme, `resourceMetadataUrl: null`, or `tokens.resources: {}`). |
| `retry-after`            | Failures whose definition declares `retryAfter`                 | Seconds. `RATE_LIMITED` uses `rateLimit.retryAfter` when set.                                                            |
| `allow`                  | `405` from the health path, a `tokens.resources` path or assets | The allowed methods.                                                                                                     |

A `101` response from a plain route or mount (a WebSocket upgrade) is returned unchanged.

### Attachments

`200` (or the declared `successStatus`) with the bytes and: `content-type`, `content-length`,
`content-disposition: attachment; filename="<ascii>"; filename*=UTF-8''<encoded>`,
`cache-control: private, no-store`, `content-security-policy: default-src 'none'; sandbox`,
`x-content-type-options: nosniff`.

### Service endpoints

| Request                                              | Response                                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /`                                              | `{ "name": "<title>", "openapi": "/openapi.json", "mcp": "/mcp" }` (`mcp` only with the transport; `openapi` includes `basePath`)                |
| `GET /health`                                        | `{ "status": "ok", "service": "<name>", "version": "<version>" }`                                                                                |
| `GET /openapi.json`                                  | The OpenAPI document as JSON                                                                                                                     |
| `GET /openapi.yaml`, `/openapi.yml`                  | The same document as YAML (`application/yaml; charset=utf-8`)                                                                                    |
| `GET /.well-known/oauth-protected-resource`, `…/mcp` | `{ "resource", "resource_name", "authorization_servers", "bearer_methods_supported": ["header"], "scopes_supported", "resource_documentation" }` |
| `GET <tokens.resources key>`                         | `{ "resource", "authorization_servers", "bearer_methods_supported": ["header"], "scopes_supported" }`                                            |

## OpenAPI

The document is OpenAPI 3.1.0: `info` (`title`, `version`), `servers` (`[{ url: origin + basePath }]`),
`paths`, `components` with `schemas.FailureResponse`, `schemas.Failure`, `schemas.ValidationIssue`,
`schemas.ResponseMetadata` and `securitySchemes`, and nothing else at its root. Every `$ref` is a local
`#/components/schemas/<name>` pointer: a schema named by its `$id` (TypeBox `Recursive` or `Ref`,
`PageInfoSchema`, a `Page`, or any schema given an `$id`) is a component of that name, one per
structural variant (`<name>_2` for the next), and its use-site `description` stays beside the
reference. Every success and failure envelope refers to `ResponseMetadata`,
`{ requestId: string }`, strict. `FailureResponse.error` is `{ allOf: [Failure], anyOf: [<one variant
per code>] }`: every variant narrows `Failure`, `{ code: string, message: string, retryable: boolean,
data: object }`, and `INVALID_INPUT`'s `data.issues` items are `ValidationIssue`,
`{ path: string (≤ 256), message: string (≤ 256) }`. The
[shared schemas](../guides/schemas-and-validation.md#shared-schemas) are components of their names.

Each operation object has `operationId`, `summary`, `description`, `tags`, `security`, `parameters`
and/or `requestBody`, and `responses`: the success status, plus one entry per status among the
failures the operation may answer (the standard ones, and its declared `failures` or else every
failure of the catalog). Each failure entry has:

- `description`: every code that answers with that status and its message, `` `CODE`: message ``,
  as a list when several codes share the status;
- `content['application/json'].schema`: `FailureResponse` narrowed to those codes,
  `{ "$ref": "#/components/schemas/FailureResponse", "properties": { "error": { "properties": { "code": { "enum": [<codes>] } } } } }`.
  JSON Schema 2020-12 applies keywords beside a `$ref`; a reader that ignores them meets the whole
  catalog, which `FailureResponse` always holds;
- `headers`: `X-Request-Id`, and `Retry-After` for `429` or when one of its codes declares
  `retryAfter`.

### OpenAPI extensions

| Extension              | On                          | Value                                                                                              |
| ---------------------- | --------------------------- | -------------------------------------------------------------------------------------------------- |
| `x-required-scopes`    | Every operation             | The operation's scopes.                                                                            |
| `x-scope-match`        | Several scopes              | `any` or `all`.                                                                                    |
| `x-conditional-scopes` | When declared               | Scopes the handler checks for part of the operation.                                               |
| `x-effect`             | Every operation             | `read`, `write` or `delete`.                                                                       |
| `x-mcp-tool`           | Operations with an MCP tool | The tool name.                                                                                     |
| `x-mcp-idempotent`     | Beside `x-mcp-tool`         | The tool's `idempotent`.                                                                           |
| `x-mcp-open-world`     | Beside `x-mcp-tool`         | The tool's `openWorld`, `true` when it declares none (its MCP `openWorldHint` uses the same).      |
| `x-native-rpc`         | Every operation             | Whether it is a native RPC method.                                                                 |
| `x-max-body-bytes`     | Every operation             | The body limit in force: the operation's `maxBodyBytes`, else the application's, else 32 768.      |
| `x-max-output-bytes`   | Every operation             | The output limit in force: the operation's `maxOutputBytes`, else the application's, else 262 144. |
| `x-body`               | Byte uploads                | `bytes`                                                                                            |
| `x-input-headers`      | Byte uploads                | Input field → request header.                                                                      |
| `x-response`           | Downloads                   | `attachment`                                                                                       |
| `x-input-field`        | Parameters of byte uploads  | The input field a query or header parameter fills.                                                 |

### Security schemes

| `tokens.scheme` | `securitySchemes`                                                                                                                                      | Operation `security`                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `oauth`         | `oauth2`: `authorizationCode` (`<issuer>authorize`, `<issuer>oauth/token`) and `clientCredentials` (`<issuer>oauth/token`), with every published scope | One requirement per scope, or one with all scopes for `scopeMatch: 'all'`                       |
| `bearer`        | `bearer`: `{ type: 'http', scheme: 'bearer', description }`                                                                                            | `[{ bearer: [] }]`                                                                              |
| `oauth+bearer`  | `oauth2` with `authorizationCode` only, and `bearer`                                                                                                   | `oauth2` requirements when `actorKinds` has `user`, plus `{ bearer: [] }` when it has `service` |

## MCP

Streamable HTTP at the transport's path, one stateless server per request. Requests are JSON-RPC 2.0;
send `accept: application/json, text/event-stream`. Responses to 2025-era requests are server-sent
events (`event: message`, `data: <json>`); a 2026-07-28 request, which carries the per-request `_meta`
envelope, is answered with one JSON body, except a `subscriptions/listen` stream.

| Item                                | Shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capabilities                        | `tools`, `resources` and `prompts`, each `{ listChanged: false }`; `extensions: { "io.modelcontextprotocol/skills": {} }` when skills are configured.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Server info                         | `{ name: <name>, title: <title>, version: <version> }`, plus `instructions`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Tool                                | `{ name, title, description, inputSchema, outputSchema, annotations: { readOnlyHint, destructiveHint, idempotentHint, openWorldHint } }`. Both schemas are self-contained, with `type: 'object'`: no `$id`, each named schema written where it is used, and a definition a `$ref` names (a recursive schema) once under `$defs`, referred to as `#/$defs/<name>`. JSON Schema validators, Ajv among them, refuse a schema that declares one `$id` twice. A union input lists as one object: every member's fields, `required` the ones every member requires, and a field the members declare differently as `enum` (literals) or `anyOf` (other schemas). |
| `tools/list` page                   | At most 50 operation tools; `nextCursor` is `<version>:<operation name>`, and any other cursor answers JSON-RPC invalid params (`-32602`). The skill tool, if any, leads the first page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Tool success                        | `{ content: [{ type: 'text', text: <output JSON> }], structuredContent: <output> }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Tool failure                        | `{ content: [{ type: 'text', text: <failure JSON> }], isError: true }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Unknown or hidden tool              | JSON-RPC error, invalid params, `Tool not found`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Server failure                      | JSON-RPC error, internal error (`-32603`), `Internal error`; reported as `maximus.unexpected`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| JSON-RPC batch (2025-03-26)         | One request for the body limit. Every message passes the rate limit as a request of its own before any of them runs; a batch over the caller's limit answers `429` with the `RATE_LIMITED` failure, and none of it runs.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `subscriptions/listen` (2026-07-28) | `notifications/subscriptions/acknowledged` with `notifications: {}`, then the stream closes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Resources                           | `openapi-json` (`<origin><basePath>/openapi.json`, `application/json`), `openapi-yaml` (`<origin><basePath>/openapi.yaml`, `application/yaml`), each guide (`<origin>/guides/<name>`, `text/markdown`), each skill (`skill://<name>/SKILL.md`, `text/markdown`).                                                                                                                                                                                                                                                                                                                                                                                           |
| Prompts                             | One per guide, named after it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `skills/list`                       | `{ resultType: 'complete', skills: [{ uri, frontmatter: { name, description }, resources: [{ uri, digest: 'sha256:<hex>', size }] }], ttlMs: 300000, cacheScope: 'public' }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `skills/get` `{ uri }`              | `{ resultType: 'complete', skill: <entry>, ttlMs, cacheScope }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Skill tool call `{ name }`          | `structuredContent: { name, description, instructions }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

A served `SKILL.md` is YAML frontmatter with `name` and `description`, then the skill's text.

## Native RPC

| Item          | Shape                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Binding props | Exactly `{ caller: string }`.                                                                                                     |
| Method        | `operationName(principal, input): Promise<Result>`                                                                                |
| Principal     | Exactly `{ actorId: string (1–255), actorKind: 'user' \| 'service', organizationId: 'org_' + 16 alphanumerics, requestId: UUID }` |
| Result        | `{ ok: true, value }` or `{ ok: false, error: Failure }`                                                                          |

## Telemetry events

`ExecutionObservation` (observers' `execution`): `service`, `operation`, `principal`, `surface`
(`http`, `mcp` or `rpc`), `occurredAt` (Unix milliseconds), `durationMicros`, `outcome` (`success` or
`failure`), `errorCode` (or `null`), `traceId` (or `null`).

`AdmissionObservation` (observers' `admission`): `service`, `operation` (or `null`), `principal` (or
`null`), `requestId`, `traceId`, `surface` (`http` or `mcp`), `occurredAt`, `durationMicros`,
`errorCode`.

`ExecutionEvent` (`@arbol-ai/maximus/analytics`): `id` (UUID), `service`, `operation`,
`organizationId`, `actorId`, `actorKind`, `requestId`, `traceId`, `surface`, `occurredAt`,
`durationMicros`, `outcome`, `errorCode`.

Native log lines are JSON with an `event` field: `maximus.admission.rejected`, `maximus.unexpected`,
and `maximus.observer.delivery_failed`. Their fields are in [Observability](../guides/observability.md#native-log-events).
