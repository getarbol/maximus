# Standard failures

Every error catalog contains these failures. Their factory names are reserved in `defineErrors`, and
their codes cannot be reused. `STANDARD_FAILURES` from `@arbol-ai/maximus/failures` lists them as
plain data, without a runtime or schema library.

| Factory               | Code                      | Status | Retryable | `Retry-After` | Message                                                                    |
| --------------------- | ------------------------- | ------ | --------- | ------------- | -------------------------------------------------------------------------- |
| `invalidInput`        | `INVALID_INPUT`           | 400    | No        |               | The request does not match the published schema.                           |
| `unauthorized`        | `UNAUTHORIZED`            | 401    | No        |               | A valid access token is required.                                          |
| `forbidden`           | `FORBIDDEN`               | 403    | No        |               | The token does not authorize this operation.                               |
| `notFound`            | `NOT_FOUND`               | 404    | No        |               | The requested operation does not exist.                                    |
| `methodNotAllowed`    | `HTTP_METHOD_NOT_ALLOWED` | 405    | No        |               | The HTTP method is not supported for this resource.                        |
| `tooLarge`            | `REQUEST_TOO_LARGE`       | 413    | No        |               | The request exceeds the allowed size.                                      |
| `unsupportedMedia`    | `UNSUPPORTED_MEDIA_TYPE`  | 415    | No        |               | The request content type is not supported.                                 |
| `rateLimited`         | `RATE_LIMITED`            | 429    | Yes       | 60            | The request rate limit was exceeded. Try again later.                      |
| `internal`            | `INTERNAL_ERROR`          | 500    | No        |               | The service could not complete the operation.                              |
| `outcomeUnknown`      | `OUTCOME_UNKNOWN`         | 502    | No        |               | The operation may have been applied; check its result before repeating it. |
| `upstreamUnavailable` | `UPSTREAM_UNAVAILABLE`    | 503    | Yes       |               | The upstream service could not complete the request.                       |
| `upstreamTimeout`     | `UPSTREAM_TIMEOUT`        | 504    | Yes       |               | The upstream service did not respond before its deadline.                  |

## When the framework produces them

| Code                      | Produced by Maximus when                                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_INPUT`           | The input fails its schema (with `data.issues`), a GET query repeats a key, a JSON body does not parse, a path field is repeated in the query or body, or a byte body cannot be read.                 |
| `UNAUTHORIZED`            | The bearer token is missing, malformed, unverifiable or carries no valid principal; an `x-api-key` header is present; RPC props or principal are invalid.                                             |
| `FORBIDDEN`               | The token lacks the operation's scopes, a resolver refused with `FORBIDDEN`, the actor kind is not eligible, or conditional scopes lack authority.                                                    |
| `NOT_FOUND`               | No route matches (before authentication), the origin is not pinned, or a discovery endpoint the configuration does not serve is requested. An unknown or hidden MCP tool is a JSON-RPC error instead. |
| `HTTP_METHOD_NOT_ALLOWED` | A non-GET request reaches the health path or a `tokens.resources` path, or a non-GET/HEAD request reaches static assets.                                                                              |
| `REQUEST_TOO_LARGE`       | A body exceeds its limit, including an MCP tool call above its operation's limit.                                                                                                                     |
| `UNSUPPORTED_MEDIA_TYPE`  | A non-GET JSON operation receives another content type, or a byte upload is content-encoded.                                                                                                          |
| `RATE_LIMITED`            | The configured rate limit refuses the organization and actor.                                                                                                                                         |
| `INTERNAL_ERROR`          | A handler throws, returns a malformed result, an invalid output, an output above its limit, or a failure outside the catalog; or a framework step fails unexpectedly.                                 |

`OUTCOME_UNKNOWN`, `UPSTREAM_UNAVAILABLE` and `UPSTREAM_TIMEOUT` are never produced by the framework
itself; your handlers return them. `INVALID_INPUT` data follows this schema:

```ts
{ issues?: { path: string /* RFC 6901 JSON Pointer, ≤ 256 */; message: string /* ≤ 256 */ }[] /* ≤ 10 */ }
```

Every other standard failure has empty `data`.

## Optional packages

`@arbol-ai/maximus/postgres` returns its own transaction failures (`{ code, message, retryable,
stage, sqlState? }`), which you translate into your catalog:

| Code                   | Retryable | Meaning                                                                   |
| ---------------------- | --------- | ------------------------------------------------------------------------- |
| `DATABASE_RETRY`       | Yes       | Serialization failure or deadlock; retried only with `databaseOnlyRetry`. |
| `DATABASE_CONFLICT`    | No        | A unique, foreign-key, check or exclusion constraint refused the change.  |
| `DATABASE_UNAVAILABLE` | Yes       | Connecting failed or the server is unavailable.                           |
| `COMMIT_UNCERTAIN`     | No        | The commit's outcome is unknown; reconcile before replaying anything.     |
| `DATABASE_FAILURE`     | No        | Any other database failure.                                               |
