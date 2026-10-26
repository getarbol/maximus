# HTTP and OpenAPI

This guide covers everything an operation does over HTTP: routes, where input comes from, responses,
limits, files and the OpenAPI document Maximus serves at runtime.

## Declare a route

```ts
base.operation(
  'createNote',
  {
    scope: 'notes:notes:write',
    effect: 'write',
    title: 'Create a note',
    description: "Store a note for the caller's organization.",
    input: CreateNoteInputSchema,
    output: NoteSchema,
    http: { method: 'POST', path: '/v1/notes', successStatus: 201 },
  },
  handler
);
```

| Field                         | Values                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `method`                      | `GET`, `POST`, `PUT`, `PATCH` or `DELETE`. `GET` only for `effect: 'read'`.                                                                                               |
| `path`                        | A versioned path: `/v<n>/` followed by one or more segments of `[A-Za-z0-9_-]`, or a whole-segment parameter such as `{noteId}`. No empty segments and no trailing slash. |
| `successStatus`               | `200` (default), `201` or `202`.                                                                                                                                          |
| `body`, `headers`, `response` | Binary uploads and downloads; see [Files](#files).                                                                                                                        |

`METHOD path` must be unique in the application. A read that needs a body, such as a search with
filters, uses `POST`; its effect stays `read`.

## Where input comes from

The operation's input schema describes one object. HTTP assembles it from the request:

| Request                             | Input                                                                                                                                                                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`                               | The query string, each declared field as its kind: an integer, number or boolean, a comma-separated list of strings, otherwise a string. A repeated key, or a value that does not read as its kind, is `INVALID_INPUT`. |
| `POST`, `PUT`, `PATCH`, `DELETE`    | The JSON body. `content-type` must be `application/json` (otherwise `UNSUPPORTED_MEDIA_TYPE`) and the body must parse (otherwise `INVALID_INPUT`). A `DELETE` with no body and no `content-type` is the empty input.    |
| Path parameters                     | Each `{name}` segment is decoded once and merged into the input.                                                                                                                                                        |
| Byte uploads (`http.body: 'bytes'`) | The query string and the mapped headers; the body is read by the handler. See [Files](#files).                                                                                                                          |

Rules that follow from this:

- A `DELETE` whose input is all in the path needs no body: an empty request with no `content-type`
  decodes as `{}`. A `DELETE` that does send a body sends JSON, like any other non-GET method.
- A path parameter must be a required `string` field of the input (of every member, for a union).
  The query string or the body may not repeat it, even with the same value.
- A GET input is one strict object, each field read from the query string as its kind (the table
  above). For any other conversion, declare the wire schema and the decoded schema separately with
  `inputSchema`; see [Schemas and validation](schemas-and-validation.md#query-strings).
- Input is never coerced: `"1"` is not `1` in a JSON body.

Unknown fields are refused because inputs are strict objects. The refusal names the field:

```json
{ "path": "/organizationId", "message": "Unexpected property" }
```

## Routing

Routing is exact and decided before authentication:

- Fixed routes are found with one map lookup by `METHOD path`.
- Routes with parameters are compiled into a segment trie when the handler is built. A static segment
  wins over a parameter in the same position. Ambiguous templates fail at construction.
- A path parameter that is empty, `.` or `..`, or that decodes to a slash, a backslash or a control
  character does not match.
- No match, including an unknown method on a known path, answers `404 NOT_FOUND` **before the token
  is read**. A missing route never reveals whether a caller is authorized.
- Paths are never normalized or redirected. `/v1/notes/` does not match `/v1/notes`.

OpenAPI declares path fields as `in: path` parameters and leaves them out of the query and the body,
and the typed client puts each one in its segment.

The service's own paths (`/`, `/health`, `/openapi.json`, `/openapi.yaml`, `/openapi.yml` and the
OAuth protected-resource paths) are reserved, as are transport paths. Collisions fail when the handler
is built.

## Responses

A successful operation answers its `successStatus` with the envelope:

```json
{ "success": true, "data": { "noteId": "…" }, "error": null, "metadata": { "requestId": "…" } }
```

A failure answers the status its catalog definition declares:

```json
{
  "success": false,
  "data": null,
  "error": {
    "code": "NOTE_NOT_FOUND",
    "message": "The note does not exist.",
    "retryable": false,
    "data": {}
  },
  "metadata": { "requestId": "…" }
}
```

Every response gets these headers:

| Header                   | Value                                                                |
| ------------------------ | -------------------------------------------------------------------- |
| `x-request-id`           | The request's UUID, also in `metadata.requestId` and in diagnostics. |
| `cache-control`          | `private, no-store`. A plain route may set its own.                  |
| `x-content-type-options` | `nosniff`                                                            |
| `server-timing`          | `total;dur=<milliseconds>`                                           |

A `401` adds `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`
(see [Authentication and scopes](authentication-and-scopes.md#oauth-discovery)). A failure whose
definition declares `retryAfter` adds `Retry-After`.

Statuses you will see from the framework itself: `400 INVALID_INPUT`, `401 UNAUTHORIZED`,
`403 FORBIDDEN`, `404 NOT_FOUND`, `405 HTTP_METHOD_NOT_ALLOWED` (non-GET on the health path or a
configured OAuth resource path), `413 REQUEST_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, `429 RATE_LIMITED` and
`500 INTERNAL_ERROR`. The [standard failures reference](../reference/standard-failures.md) lists
them all.

## Limits

| Limit        | Default         | Set with                                                                                        |
| ------------ | --------------- | ----------------------------------------------------------------------------------------------- |
| Request body | 32 KiB          | Application `maxBodyBytes`, or an operation's `maxBodyBytes` (not on GET). At most 16 MiB.      |
| Output       | 256 KiB of JSON | Application `maxOutputBytes`, or an operation's `maxOutputBytes`. At most 16 MiB per operation. |

Keep the application limit small and raise it only on the operations that need it, such as an
import. A larger body answers `413 REQUEST_TOO_LARGE`, counting chunked bodies as they arrive. An
output above its limit is a bug in the service and answers `500 INTERNAL_ERROR`. OpenAPI publishes
operation limits as `x-max-body-bytes` and `x-max-output-bytes`.

## Rate limits

```ts
maximus<Env>({
  // ...
  rateLimit: { binding: 'API_RATE_LIMIT', retryAfter: 60 },
});
```

`binding` names a [Workers rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
in your environment:

```jsonc
"ratelimits": [{ "name": "API_RATE_LIMIT", "namespace_id": "1001", "simple": { "limit": 100, "period": 60 } }]
```

After a token is verified, each HTTP operation call and each MCP request is counted under a SHA-256
key of the organization and actor, and so is every further request one MCP request carries in a
JSON-RPC batch. Over the limit, Maximus answers `429 RATE_LIMITED` with `Retry-After: <retryAfter>`
(60 by default) before preparing any context; a refused batched request answers the `RATE_LIMITED`
failure over MCP instead.

## Files

Binary uploads and attachment downloads are ordinary operations with an explicit HTTP shape. They are
HTTP-only: such an operation cannot also declare `mcp` or `rpc`.

### Uploads

```ts
import { ok, t, UuidSchema } from '@arbol-ai/maximus';

base.operation(
  'uploadAttachment',
  {
    scope: 'notes:attachments:write',
    effect: 'write',
    title: 'Upload an attachment',
    description: 'Store the request body as the attachment of a note.',
    maxBodyBytes: 5 * 1024 * 1024,
    input: t.Object(
      { noteId: UuidSchema, contentType: t.String({ maxLength: 100 }) },
      { additionalProperties: false }
    ),
    output: t.Object({ bytes: t.Integer() }, { additionalProperties: false }),
    http: {
      method: 'PUT',
      path: '/v1/notes/{noteId}/attachment',
      body: 'bytes',
      headers: { contentType: 'content-type' },
    },
  },
  async ({ body }, input) => {
    // Check that the note exists and belongs to the organization before reading any bytes.
    const bytes = await body.read();
    if (!bytes.ok) {
      return bytes;
    }
    // Store bytes.value under a key the service controls, with input.contentType.
    return ok({ bytes: bytes.value.byteLength });
  }
);
```

- `http.body: 'bytes'` hands the handler `context.body`, whose `read()` returns a `Result` with a
  `Uint8Array`, reads at most once and enforces `maxBodyBytes`. A compressed upload
  (`content-encoding` other than `identity`) is `UNSUPPORTED_MEDIA_TYPE`.
- The rest of the input comes from the path, the query string and `http.headers`, which maps input
  fields to request headers. A mapped header cannot be `authorization`, `cookie`, `host`,
  `content-length` or `content-encoding` or name a path field, and a request may not also send a
  header-mapped field in its query string.
- The owner owns file signatures, storage keys, retention and reconciling a failed write.

### Downloads

```ts
import { AttachmentOutputSchema, ok } from '@arbol-ai/maximus';

base.operation(
  'exportNote',
  {
    scope: 'notes:notes:read',
    effect: 'read',
    title: 'Export a note',
    description: 'Download a note as a text file.',
    input: t.Object({ noteId: UuidSchema }, { additionalProperties: false }),
    output: AttachmentOutputSchema,
    http: { method: 'GET', path: '/v1/notes/{noteId}/export', response: 'attachment' },
  },
  async (_context, input) => {
    const body = new TextEncoder().encode(`Note ${input.noteId}`);
    return ok({
      body,
      contentType: 'text/plain',
      filename: `${input.noteId}.txt`,
      byteLength: body.byteLength,
    });
  }
);
```

The handler returns `{ body, contentType, filename, byteLength }`, where `body` is a `Uint8Array` or a
`ReadableStream`; a handler can never return a raw `Response` that bypasses validation. Maximus checks the metadata before responding, streams exactly `byteLength` bytes
(a stream that sends more or less fails), and sets `content-type`, `content-length`,
`content-disposition` (ASCII and RFC 5987 forms), `cache-control: private, no-store`,
`content-security-policy: default-src 'none'; sandbox` and `nosniff`. `byteLength` counts against
`maxOutputBytes`.

## The OpenAPI document

`GET /openapi.json`, `/openapi.yaml` and `/openapi.yml` serve the same OpenAPI 3.1 document, built
from the application the first time it is requested. It contains:

- every operation that declares an HTTP route and is public: not `visibility: 'internal'`;
- for each one: `operationId` (the operation name), `summary` (title), `description`, `tags`
  (`group`, or the name), security requirements, parameters or request body, the success response
  and one response per failure status it may answer, which names every code that answers with that
  status and narrows `FailureResponse` to them;
- the security scheme (see below), a `FailureResponse` component and the `ResponseMetadata`
  component every envelope's `metadata` refers to, plus one component per schema named by its
  `$id` (a recursive TypeBox schema, `PageInfo` and each [list page](schemas-and-validation.md#lists)),
  so every schema reference is local.

The root holds OpenAPI's own fields only: `openapi`, `info`, `servers`, `paths` and `components`.

Scopes become OAuth security requirements. A list of scopes is a list of alternatives; with
`scopeMatch: 'all'` it is one requirement holding every scope. Maximus-specific facts are extensions:

| Extension                                | Meaning                                                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x-required-scopes`                      | The operation's scopes.                                                                                                                                          |
| `x-scope-match`                          | `any` or `all`; present for several scopes.                                                                                                                      |
| `x-conditional-scopes`                   | Scopes the handler checks for part of the operation.                                                                                                             |
| `x-effect`                               | `read`, `write` or `delete`.                                                                                                                                     |
| `x-mcp-tool`                             | The MCP tool name, when the operation declares a tool; `x-mcp-idempotent` and `x-mcp-open-world` (`true` unless the tool declares `openWorld: false`) beside it. |
| `x-native-rpc`                           | Whether the operation is a native RPC method.                                                                                                                    |
| `x-max-body-bytes`, `x-max-output-bytes` | The limits in force: the operation's, else the application's, else the defaults (32 KiB and 256 KiB).                                                            |
| `x-body`, `x-input-headers`              | Binary upload shape.                                                                                                                                             |
| `x-response`                             | `attachment` for downloads.                                                                                                                                      |

Security schemes depend on `tokens.scheme`:

| Scheme            | Published as                                                                                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oauth` (default) | `oauth2` with `authorizationCode` and `clientCredentials` flows. Their URLs are `tokens.authorizationEndpoint` and `tokens.tokenEndpoint`, by default `authorize` and `oauth/token` resolved against `tokens.issuer`. |
| `bearer`          | An HTTP `bearer` scheme with your description.                                                                                                                                                                        |
| `oauth+bearer`    | `oauth2` (authorization code only) and `bearer`, chosen per operation by its `actorKinds`.                                                                                                                            |

To produce the same document at build time (to generate an SDK, say), call `createOpenApi(app)`. It
contains no credentials, internal operations or handlers, and serving it grants nothing: every
operation still checks its token.

## Discovery endpoints

| Path                                        | Answer                                                                                                                                                                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`                                     | `{ "name": title, "openapi": "/openapi.json", "mcp": "/mcp" }` (`mcp` only with the transport).                                                                                                                        |
| `GET /health`                               | `{ "status": "ok", "service": name, "version": version }`. No dependency is probed. Move it with `http.healthPath`.                                                                                                    |
| `GET /.well-known/oauth-protected-resource` | RFC 9728 metadata: `resource` (the audience, or the first of `tokens.audience`'s list), `authorization_servers`, `scopes_supported` and `resource_documentation`. Also at `/.well-known/oauth-protected-resource/mcp`. |

None of them needs a token. The OAuth metadata endpoints also answer
`access-control-allow-origin: *`, and only `GET`.

## Origins and mounting

- `http.origins: ['https://notes.example.com']` pins exact HTTPS origins. A request to any other
  origin is `NOT_FOUND` before metadata, hooks or token handling.
- `http.basePath: '/api'` serves operations and discovery below a path prefix. OpenAPI's server URL
  includes it.

Both are options of `createWorker(app, { http })`; see [Worker composition](worker-composition.md).

Adapters can add per-operation metadata with `createOpenApi(app, { operationExtensions: (name,
operation) => ({ 'x-owner-operation': name, 'x-owner-input': operation.input }) })`. Only `x-` keys
are accepted. Named schemas in these extensions share the native document's components and local
references; runtime schemas and authorization remain unchanged.
