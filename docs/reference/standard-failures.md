# Standard failures

Every error catalog holds these failures, and every operation may answer them without declaring them. This
page lists each one with its status, its retry semantics and its message, then when it is answered and the
data it carries. [Errors and results](../guides/errors-and-results.md) explains catalogs and failures.

| Name                  | Code                      | Status | Retryable | `retry-after`                                   | Message                                                                    |
| --------------------- | ------------------------- | ------ | --------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| `invalidInput`        | `INVALID_INPUT`           | 400    | No        |                                                 | The request does not match the published schema.                           |
| `unauthorized`        | `UNAUTHORIZED`            | 401    | No        |                                                 | A valid access token is required.                                          |
| `forbidden`           | `FORBIDDEN`               | 403    | No        |                                                 | The token does not authorize this operation.                               |
| `notFound`            | `NOT_FOUND`               | 404    | No        |                                                 | The requested operation does not exist.                                    |
| `methodNotAllowed`    | `HTTP_METHOD_NOT_ALLOWED` | 405    | No        |                                                 | The HTTP method is not supported for this resource.                        |
| `tooLarge`            | `REQUEST_TOO_LARGE`       | 413    | No        |                                                 | The request exceeds the allowed size.                                      |
| `unsupportedMedia`    | `UNSUPPORTED_MEDIA_TYPE`  | 415    | No        |                                                 | The request content type is not supported.                                 |
| `rateLimited`         | `RATE_LIMITED`            | 429    | Yes       | 60, or the application's `rateLimit.retryAfter` | The request rate limit was exceeded. Try again later.                      |
| `internal`            | `INTERNAL_ERROR`          | 500    | No        |                                                 | The service could not complete the operation.                              |
| `upstreamUnavailable` | `UPSTREAM_UNAVAILABLE`    | 503    | Yes       |                                                 | The upstream service could not complete the request.                       |
| `upstreamTimeout`     | `UPSTREAM_TIMEOUT`        | 504    | Yes       |                                                 | The upstream service did not respond before its deadline.                  |
| `outcomeUnknown`      | `OUTCOME_UNKNOWN`         | 502    | No        |                                                 | The operation may have been applied; check its result before repeating it. |

The name is the failure's factory in every catalog, `errors.notFound.create()`, and `defineErrors` refuses a
domain failure of the same name. No domain failure may take one of these codes. A handler answers any of them
with `fail(code)`, whatever its `failures` list, except the five that routing, admission and reading a body
answer before a handler could: `NOT_FOUND`, `HTTP_METHOD_NOT_ALLOWED`, `UNAUTHORIZED`, `REQUEST_TOO_LARGE`
and `UNSUPPORTED_MEDIA_TYPE`. `fail` does not take those, and one that a handler, context or middleware
answers anyway is `INTERNAL_ERROR`; a byte body's `read()` answers the last two itself.

## When each is answered

### INVALID_INPUT

- An input does not match its schema, on any transport. The failure carries `data.issues`.
- An input is not a plain JSON tree: it is nested deeper than 100 levels, or an object of it has the key
  `__proto__`. The failure carries one issue, `Input must be a bounded plain JSON tree.`, at the empty path.
- A GET's query string repeats a key, has the key `__proto__`, or holds a value that does not read as its
  field's kind.
- A JSON body is not UTF-8 or does not parse, or is not an object while the route has path parameters.
- The query string or the body names a field of the path.
- A byte upload's query string repeats a key, or names a field the route reads from a header.
- A body breaks off while it is read, or declares a malformed `content-length`.

Only the first two carry issues.

### UNAUTHORIZED

- The request has no `authorization: Bearer <token>` header, or its token is longer than 16,384 characters,
  or, when the application verifies OAuth access tokens alone, is not the three parts of a JWT.
- The request has an `x-api-key` header.
- The token fails verification, or its claims do not name a valid principal.
- `tokens.resolve` refuses the token with any failure but `FORBIDDEN`, throws, or answers an invalid
  principal.
- Over RPC, the Service Binding's props are not exactly `{ caller }` naming a caller the operation allows,
  or the principal does not match its schema. The method answers the failure as a Result.

Over HTTP and MCP, the response carries a `www-authenticate` challenge, as [Wire
formats](wire-formats.md#headers) describes.

### FORBIDDEN

- The verified token lacks the operation's scope (any one of its scopes, or all of them under
  `scopeMatch: 'all'`), or the MCP endpoint's `<namespace>:mcp:use`.
- `tokens.resolve` refuses the token with `FORBIDDEN`.
- The caller's actor kind is not among the operation's `actorKinds`.
- The operation declares `conditionalScopes` and the call has no verified authority: an RPC call, or a token
  `tokens.resolve` admitted without a client.

Over MCP, a call to a tool the token's scopes or actor kind do not admit answers the JSON-RPC error
`Tool not found` instead, as for a tool that does not exist.

### NOT_FOUND

- No route matches the request's method and path: an unknown path below the base path, a method its path
  does not serve, or a segment that decodes to an unsafe value. It is answered before the token is read.
- The Worker pins its origins with `http.origins`, and the request is for another.
- The OAuth protected-resource metadata is requested under the application's own `bearer` token scheme, or
  while `tokens.resources` names the resources.
- A path outside the API that no page, plain route or web app file answers.

Over MCP, a call to a tool that does not exist answers the JSON-RPC error `Tool not found`.

### HTTP_METHOD_NOT_ALLOWED

- A method other than GET at the health path or at a path of `tokens.resources`, with `allow: GET`.
- A method no file of a page's path declares, with `allow` listing the ones that do: `GET, HEAD` for a
  page that answers `GET`.
- A method other than GET and HEAD at a web app's file, with `allow: GET, HEAD`.

### REQUEST_TOO_LARGE

- A JSON body is beyond its operation's `maxBodyBytes`, by its `content-length` or as its bytes arrive.
- An MCP request is beyond the largest limit among the tools its caller may call; it answers HTTP `413`.
- An MCP tool call is beyond the limit of its operation; it answers a tool result with `isError: true`.
- A byte upload is beyond its route's `maxBodyBytes`, as its handler's `body.read()` answers.

### UNSUPPORTED_MEDIA_TYPE

- A POST, PUT, PATCH or DELETE request has a `content-type` other than `application/json`, or none, unless
  it is a DELETE without a body.
- A byte upload's `content-encoding` is anything but `identity`, as its handler's `body.read()` answers.

### RATE_LIMITED

- The application's rate limiting binding refuses the caller's organization and actor, after its token is
  verified and before its body is read: an HTTP call, an MCP request, or any message of an MCP batch, which
  refuses the whole batch. Calls over RPC are not rate limited.

### INTERNAL_ERROR

- A handler, `context.ts` or middleware throws.
- An operation answers an output its schema refuses, an output beyond its limit, an attachment that fails its
  checks, or, from the builder, a value that is not a Result.
- An operation answers a failure the catalog does not define, one that differs from its definition, or a
  domain failure it does not declare.
- A handler calls `fail` with a code the catalog lacks, or with data its `dataSchema` refuses.
- An input codec throws something other than a refusal.
- The rate limiting binding is missing or fails.
- A plain route or a page throws, or any other step fails unexpectedly.

The caller never receives the error's text. Maximus reports it as `maximus.unexpected` with its safe
description, as [Observability](../guides/observability.md) describes.

### UPSTREAM_UNAVAILABLE, UPSTREAM_TIMEOUT and OUTCOME_UNKNOWN

Maximus never answers these itself; handlers do:

- `UPSTREAM_UNAVAILABLE`: a dependency could not complete the request, and the same call may succeed later.
- `UPSTREAM_TIMEOUT`: a dependency did not answer before its deadline, and the same call may succeed later.
- `OUTCOME_UNKNOWN`: a write may have been applied and its answer was lost. The caller reconciles before it
  repeats anything, as [Uncertain outcomes](../guides/errors-and-results.md#uncertain-outcomes) describes.

## Data

`INVALID_INPUT` carries this `data`; every other standard failure carries `{}`:

```ts
{
  issues?: {
    path: string; // RFC 6901 JSON Pointer of the refused field, empty for the whole input; at most 256 characters
    message: string; // what was expected, never the value; at most 256 characters
  }[]; // at most 10
}
```

The OpenAPI document names an issue's schema `ValidationIssue`.

## In code

- `standardErrors`, from `@arbol-ai/maximus`, is the catalog of the standard failures alone.
- `STANDARD_FAILURES`, from `@arbol-ai/maximus/failures`, lists them by name as plain data,
  `{ code, status, message, retryable?, retryAfter? }`, without a runtime or a schema library: for code that
  presents them, such as a gateway.

The failures of optional entries are not catalog failures: `@arbol-ai/maximus/postgres` answers its own
transaction failures, as [Postgres transactions](../guides/postgres.md) describes, and the bounded body
readers answer `HTTP_BODY_INVALID`. A handler translates them into its catalog.
