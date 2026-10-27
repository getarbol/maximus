# Wire formats

This page lists what a Maximus Worker sends and accepts: the HTTP envelope and headers, attachments, lists,
the service's own endpoints, the OpenAPI document and its extensions, MCP, native RPC and the YAML it
writes. The guides explain when each one appears; look its exact shape up here.

## HTTP

### Envelope

Every operation answers a JSON envelope, `content-type: application/json`:

```ts
type Success<T> = { success: true; data: T; error: null; metadata: { requestId: string } };
type Refusal = { success: false; data: null; error: Failure; metadata: { requestId: string } };
type Failure = { code: string; message: string; retryable: boolean; data: object };
```

A success answers with the route's `http.successStatus`, `200` unless declared, and a failure with the status
its definition declares. An [attachment](#attachments) answers its bytes instead. Pages, plain routes,
mounts and a web app's files answer their own formats, and so do the [service's own
endpoints](#the-services-own-endpoints). The OpenAPI document names `metadata` `ResponseMetadata` and the
refusal `FailureResponse`.

### Headers

| Header                        | On                                               | Value                                                                                                        |
| ----------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `x-request-id`                | Every response                                   | A UUID minted for the request, never one the caller sends; the envelope's `metadata.requestId`.              |
| `cache-control`               | Every response                                   | `private, no-store`, unless a page, a plain route, a mount or a web app's file sets its own.                 |
| `x-content-type-options`      | Every response                                   | `nosniff`                                                                                                    |
| `server-timing`               | Every response                                   | `total;dur=<milliseconds>`, with one decimal.                                                                |
| `content-type`                | Envelopes and the service's documents            | `application/json`, and `application/yaml; charset=utf-8` for the YAML document.                             |
| `www-authenticate`            | `401`                                            | `Bearer resource_metadata="<url>"`, or `Bearer` alone; see below.                                            |
| `retry-after`                 | A failure whose definition declares `retryAfter` | Its seconds. `RATE_LIMITED` sends the application's `rateLimit.retryAfter`, else 60.                         |
| `allow`                       | `405`                                            | `GET` at the health path and at the paths of `tokens.resources`; `GET, HEAD` at pages and a web app's files. |
| `access-control-allow-origin` | The OAuth protected-resource metadata            | `*`                                                                                                          |

The challenge's `<url>` is `tokens.resourceMetadataUrl`, a string or what its function answers for the
request, and otherwise `<origin><base path>/.well-known/oauth-protected-resource`. The challenge is `Bearer`
alone under the application's own `bearer` token scheme, when `tokens.resourceMetadataUrl` is or answers
`null`, and when `tokens.resources` is `{}`.

A `101` response, the WebSocket upgrade of a plain route or a mount, is returned as it is, without these
headers.

### Attachments

An attachment answers its bytes with the route's success status and these headers:

| Header                    | Value                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content-type`            | The attachment's `contentType`.                                                                                                                                                                               |
| `content-length`          | Its `byteLength`.                                                                                                                                                                                             |
| `content-disposition`     | `attachment; filename="<name>"; filename*=UTF-8''<encoded name>`: in the first form every character outside printable ASCII, `"` and `\` becomes `_`, and the second is percent-encoded as RFC 8187 requires. |
| `cache-control`           | `private, no-store`                                                                                                                                                                                           |
| `content-security-policy` | `default-src 'none'; sandbox`                                                                                                                                                                                 |
| `x-content-type-options`  | `nosniff`                                                                                                                                                                                                     |

### Lists

A list declared with `PageQueryFields` and `Page(item, { $id })` takes these query parameters:

| Parameter   | Schema                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `cursor`    | An optional string: the opaque cursor from a previous page's `pageInfo`, absent for the first page.                  |
| `direction` | `forward` or `backward`, `forward` by default: the direction from the cursor in the list's stable order.             |
| `limit`     | An integer from 1 to 100, 25 by default (another maximum and default with `pageLimit`): the most items a page holds. |

and answers this `data`:

```ts
type Page<Item> = { object: 'list'; data: Item[]; pageInfo: PageInfo }; // the component named by its $id
type PageInfo = {
  hasNextPage: boolean; // a later page exists in the current order
  hasPreviousPage: boolean; // an earlier page exists in the current order
  nextCursor: string | null; // null when there is no next page
  previousCursor: string | null; // null when there is no previous page
}; // the component PageInfo
```

Both are strict: no other field is accepted. A list has no page number, offset or total.

### The service's own endpoints

None of them needs a token. `<base path>` is `/api` unless `http.basePath` names another.

| Request                                                                                    | Answer                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET <base path>`                                                                          | `{ "name": "<title>", "openapi": "<base path>/openapi.json", "mcp": "/mcp" }`, `mcp` only when the application configures MCP and serves the transport.                                                                                                                                                                                                                                                           |
| `GET /health`                                                                              | `{ "status": "ok", "service": "<name>", "version": "<version>" }`, at `http.healthPath` when it names another path.                                                                                                                                                                                                                                                                                               |
| `GET <base path>/openapi.json`                                                             | The OpenAPI document.                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET <base path>/openapi.yaml`, `GET <base path>/openapi.yml`                              | The same document as [YAML](#yaml).                                                                                                                                                                                                                                                                                                                                                                               |
| `GET <base path>/.well-known/oauth-protected-resource`, and the same path ending in `/mcp` | RFC 9728 metadata: `resource`, the first audience; `resource_name`, the title; `authorization_servers`, the issuer; `bearer_methods_supported: ["header"]`; `scopes_supported`, the scopes of the public routes and tools, and `<namespace>:mcp:use` when MCP is served; `resource_documentation`, the URL of `openapi.json`. `NOT_FOUND` under the application's own `bearer` scheme or with `tokens.resources`. |
| `GET` a path of `tokens.resources`                                                         | That resource's metadata: `resource`, `authorization_servers`, `bearer_methods_supported: ["header"]` and `scopes_supported`.                                                                                                                                                                                                                                                                                     |

## OpenAPI

### The document

The document is OpenAPI 3.1.0 and holds, at its root, only `openapi`, `info` (`title` and `version`),
`servers`, `paths` and `components` (`schemas` and `securitySchemes`). The Worker's server URL is its origin
with the base path, `[{ "url": "https://notes.example.com/api" }]`, and each path is a route's template
without it, `/v1/notes/{noteId}`, with its operations under their lowercase methods. `createOpenApi(app)`
builds the document an application describes, whose server URL is the origin alone.

`components.schemas` holds:

| Component          | Schema                                                                                                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ResponseMetadata` | `{ requestId: string }`, strict: every envelope's `metadata`.                                                                                                                                                                                  |
| `Failure`          | `{ code: string, message: string, retryable: boolean, data: object }`, strict: the base of every failure.                                                                                                                                      |
| `ValidationIssue`  | `{ path: string, message: string }`, strict, each at most 256 characters: an issue of `INVALID_INPUT`.                                                                                                                                         |
| `FailureResponse`  | `{ success: false, data: null, error, metadata: ResponseMetadata }`, strict, where `error` is `{ allOf: [Failure], anyOf: [<one variant per code>] }`, each variant fixing its `code`, `message` and `retryable` and giving its `data` schema. |
| A schema's `$id`   | Each named schema the document uses: the shared schemas, every page and the service's own. Two different shapes of one name are `<name>` and `<name>_2`.                                                                                       |

Every `$ref` is a local `#/components/schemas/<name>`, and the document holds no `$id`. A description given
where a named schema is used stays beside its reference.

### Operations

Each public operation with a route is one operation object:

| Field         | Value                                                                                                                                                                                                                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operationId` | The operation's name.                                                                                                                                                                                                                                                                                                                                |
| `summary`     | Its title.                                                                                                                                                                                                                                                                                                                                           |
| `description` | Its description, when it has one.                                                                                                                                                                                                                                                                                                                    |
| `security`    | The requirements that admit it; see [Security schemes](#security-schemes).                                                                                                                                                                                                                                                                           |
| `tags`        | `[<group>]`, or `[<operation name>]` without a group.                                                                                                                                                                                                                                                                                                |
| `x-…`         | Its [extensions](#openapi-extensions).                                                                                                                                                                                                                                                                                                               |
| `parameters`  | Each path parameter, `in: path` and required. For a GET, each other input field `in: query`, required as the input requires it, and a list of strings with `style: 'form'` and `explode: false`, one comma-separated value. For a byte upload, each other field `in: query`, or `in: header` under the header it is read from, with `x-input-field`. |
| `requestBody` | For every method but GET, a required body: `application/json`, the input without the path's fields, or for a byte upload `application/octet-stream`, `{ type: 'string', format: 'binary' }`.                                                                                                                                                         |
| `responses`   | The success status, and one response per status of the failures it may answer.                                                                                                                                                                                                                                                                       |

The success response is `application/json`, the strict envelope
`{ success: true, data: <output>, error: null, metadata: ResponseMetadata }`. For an attachment, it is
`application/octet-stream`, `{ type: 'string', format: 'binary' }`, with the headers `Content-Type`,
`Content-Length` and `Content-Disposition`.

The failures an operation may answer are the standard ones and its declared `failures`, or every failure of
the catalog when it declares none. Each status among them is one response:

- `description`: each code of that status with its message, `` `CODE`: message ``, in catalog order and as a
  list when several codes share it;
- `headers`: `X-Request-Id`, and `Retry-After` (an integer) for `429` or when one of its codes declares
  `retryAfter`;
- `content['application/json'].schema`: `FailureResponse` narrowed to those codes,
  `{ "$ref": "#/components/schemas/FailureResponse", "properties": { "error": { "properties": { "code": { "enum": [<codes>] } } } } }`.
  JSON Schema 2020-12 applies keywords beside a `$ref`; a reader that ignores them meets the whole catalog,
  which `FailureResponse` always holds.

### OpenAPI extensions

| Extension              | On                                           | Value                                                                                     |
| ---------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `x-required-scopes`    | Every operation                              | Its scopes.                                                                               |
| `x-scope-match`        | An operation with several scopes             | `any` or `all`.                                                                           |
| `x-conditional-scopes` | An operation that declares them              | Its conditional scopes.                                                                   |
| `x-effect`             | Every operation                              | `read`, `write` or `delete`.                                                              |
| `x-mcp-tool`           | An operation that is an MCP tool             | The tool's name.                                                                          |
| `x-mcp-idempotent`     | Beside `x-mcp-tool`                          | The tool's `idempotent`.                                                                  |
| `x-mcp-open-world`     | Beside `x-mcp-tool`                          | The tool's `openWorld`, `true` when it declares none.                                     |
| `x-native-rpc`         | Every operation                              | Whether it is a native RPC method.                                                        |
| `x-max-body-bytes`     | Every operation                              | The body limit in force: its own `maxBodyBytes`, else the application's, else 32768.      |
| `x-max-output-bytes`   | Every operation                              | The output limit in force: its own `maxOutputBytes`, else the application's, else 262144. |
| `x-body`               | A byte upload                                | `bytes`                                                                                   |
| `x-input-headers`      | A byte upload                                | Input field to request header; `{}` when it reads none from a header.                     |
| `x-response`           | An attachment                                | `attachment`                                                                              |
| `x-input-field`        | A query or header parameter of a byte upload | The input field the parameter fills.                                                      |

`createOpenApi(app, { operationExtensions: (name, operation) => ({ … }) })` adds an adapter's own
extensions to each operation; a key without the `x-` prefix throws `OpenAPI extensions must use x- names.`
Schemas in them share the document's components.

### Security schemes

| `tokens.scheme`     | `securitySchemes`                                                                                                                                 | An operation's `security`                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `oauth`, by default | `oauth2`, with the flows `authorizationCode` and `clientCredentials` and, in each, every scope and conditional scope of the documented operations | One requirement per scope, `{ "oauth2": [<scope>] }`, or one with all of them under `scopeMatch: 'all'`  |
| `bearer`            | `bearer`: `{ type: 'http', scheme: 'bearer', description }`                                                                                       | `[{ "bearer": [] }]`                                                                                     |
| `oauth+bearer`      | `oauth2` with `authorizationCode` alone, and `bearer`                                                                                             | The `oauth2` requirements when `actorKinds` holds `user`, and `{ "bearer": [] }` when it holds `service` |

The flows' `authorizationUrl` is `tokens.authorizationEndpoint`, `authorize` unless set, and their `tokenUrl`
is `tokens.tokenEndpoint`, `oauth/token` unless set, each resolved against `tokens.issuer`.

## MCP

The MCP transport serves Streamable HTTP at its path, `/mcp`, with one stateless server per request. Requests
are JSON-RPC 2.0, sent with `accept: application/json, text/event-stream`. Responses to 2025-era requests
are server-sent events (`event: message`, `data: <json>`); a 2026-07-28 request, which carries the
per-request `_meta` envelope, is answered with one JSON body, except a `subscriptions/listen` stream. A
request refused before the server runs, for its token, its scope, the rate limit or its body, answers the
[HTTP envelope](#envelope).

| Item                                | Shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capabilities                        | `tools`, `resources` and `prompts`, each `{ listChanged: false }`; `extensions: { "io.modelcontextprotocol/skills": {} }` when skills are configured.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Server info                         | `{ name: <name>, title: <title>, version: <version> }`, plus `instructions`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Tool                                | `{ name, title, description, inputSchema, outputSchema, annotations: { readOnlyHint, destructiveHint, idempotentHint, openWorldHint } }`. Both schemas are self-contained, with `type: 'object'`: no `$id`, each named schema written where it is used, and a definition a `$ref` names (a recursive schema) once under `$defs`, referred to as `#/$defs/<name>`. JSON Schema validators, Ajv among them, refuse a schema that declares one `$id` twice. A union input lists as one object: every member's fields, `required` the ones every member requires, and a field the members declare differently as `enum` (literals) or `anyOf` (other schemas). |
| `tools/list` page                   | At most 50 operation tools; `nextCursor` is `<version>:<operation name>`, and any other cursor answers JSON-RPC invalid params (`-32602`), `Invalid cursor`. The skill tool, if any, leads the first page.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Tool success                        | `{ content: [{ type: 'text', text: <output JSON> }], structuredContent: <output> }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Tool failure                        | `{ content: [{ type: 'text', text: <failure JSON> }], isError: true }`, also for a call beyond its operation's body limit (`REQUEST_TOO_LARGE`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Unknown or hidden tool              | JSON-RPC error, invalid params (`-32602`), `Tool not found`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Server failure                      | JSON-RPC error, internal error (`-32603`), `Internal error`; reported as `maximus.unexpected`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| JSON-RPC batch (2025-03-26)         | One request for the body limit. Every message passes the rate limit as a request of its own before any of them runs; a batch over the caller's limit answers `429` with the `RATE_LIMITED` failure, and none of it runs.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Tool call (2026-07-28)              | Names its tool in the `mcp-name` header as well; a request whose header names no tool or another answers `400`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `subscriptions/listen` (2026-07-28) | `notifications/subscriptions/acknowledged` with `notifications: {}`, then the stream closes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Resources                           | `openapi-json` (`<origin><base path>/openapi.json`, `application/json`), `openapi-yaml` (`<origin><base path>/openapi.yaml`, `application/yaml`), each guide (`<origin>/guides/<name>`, `text/markdown`), each skill (`skill://<name>/SKILL.md`, `text/markdown`).                                                                                                                                                                                                                                                                                                                                                                                         |
| Prompts                             | One per guide, named after it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `skills/list`                       | `{ resultType: 'complete', skills: [{ uri, frontmatter: { name, description }, resources: [{ uri, digest: 'sha256:<hex>', size }] }], ttlMs: 300000, cacheScope: 'public' }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `skills/get` `{ uri }`              | `{ resultType: 'complete', skill: <entry>, ttlMs, cacheScope }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Skill tool call `{ name }`          | `structuredContent: { name, description, instructions }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

A served `SKILL.md` is YAML frontmatter with `name` and `description`, then the skill's text.

## Native RPC

Each operation that declares `rpc` is a method of the Worker's `Service` entrypoint, named after the
operation:

| Item          | Shape                                                                                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Binding props | Exactly `{ caller: string }`, naming a caller the operation allows.                                                                                                                      |
| Method        | `<operation name>(principal, input): Promise<Result>`                                                                                                                                    |
| Principal     | Exactly `{ actorId, actorKind, organizationId, requestId }`: `actorId` 1 to 255 characters, `actorKind` `user` or `service`, `organizationId` an `OrganizationId`, `requestId` a `Uuid`. |
| Result        | `{ ok: true, value: <output> }` or `{ ok: false, error: Failure }`                                                                                                                       |

Props or a principal that do not match answer `{ ok: false, error }` with `UNAUTHORIZED`. A call over RPC
carries no token, so no scope is checked and an operation with `conditionalScopes` answers `FORBIDDEN`; its
actor kind, input, output and failures are checked as on every transport, and no rate limit applies.

## YAML

`/openapi.yaml` and a skill's frontmatter are YAML written from JSON values, so that a YAML 1.2 reader takes
every value back as the JSON it came from, and a YAML 1.1 reader every string back as the same string:

- Mappings and sequences are written in block style, indented two spaces per level. An item that is a
  mapping starts on its dash: `- name: tasks`.
- An empty mapping is `{}` and an empty sequence `[]`. `null`, `true`, `false` and numbers are written as
  JSON writes them. A field whose value is undefined is left out, as JSON leaves it out.
- A string, a key or a value, is written plain when it starts with a letter or `_`, holds only letters,
  digits, `_`, `.`, `/` and `-`, and is not `y`, `n`, `yes`, `no`, `on`, `off`, `true`, `false` or `null` in any
  case. Any other string is double-quoted with JSON's escapes, and U+007F to U+0084, U+0086 to U+009F, U+FFFE
  and U+FFFF are written as `\u` escapes.
- The document ends with a line break.

## Telemetry events

The events Maximus writes to the Worker's logs and the observations its observers receive are listed in
[Observability](../guides/observability.md): its [native log
events](../guides/observability.md#native-log-events) and [observers](../guides/observability.md#observers).
