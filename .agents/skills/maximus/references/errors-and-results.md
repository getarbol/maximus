# Errors and results

## Results

```ts
import { err, ok } from '@arbol-ai/maximus';

return note ? ok(note) : err(errors.noteNotFound.create());
```

A handler returns exactly `{ ok: true, value }` or `{ ok: false, error }`. Anything else, a throw, an
output that fails its schema or exceeds its byte limit, or a failure outside the catalog becomes
`INTERNAL_ERROR`, reported to diagnostics without its message.

## Catalog

```ts
export const errors = defineErrors({
  noteNotFound: { code: 'NOTE_NOT_FOUND', status: 404, message: 'The note does not exist.' },
  quotaExceeded: {
    code: 'QUOTA_EXCEEDED',
    status: 429,
    message: 'The organization has reached its note quota.',
    retryable: true,
    retryAfter: 3600,
    dataSchema: t.Object({ limit: t.Integer() }, { additionalProperties: false }),
  },
});

errors.quotaExceeded.create({ limit: 100 }); // data required when dataSchema has required fields
errors.noteNotFound.is(value);
errors.status('NOTE_NOT_FOUND'); // 404
```

- Codes `UPPER_SNAKE_CASE`, unique including standard codes; status 400–599; messages fixed and
  value-free; `dataSchema` strict.
- Standard names are reserved keys: `invalidInput`, `unauthorized`, `forbidden`, `notFound`,
  `methodNotAllowed`, `tooLarge`, `unsupportedMedia`, `rateLimited`, `internal`,
  `upstreamUnavailable`, `upstreamTimeout`, `outcomeUnknown`. Every catalog contains them, so use
  `errors.forbidden.create()` etc. `standardErrors` is the catalog with nothing added.
- The catalog's members are reserved keys too: `schema`, `definitions`, `status`, `retryAfter`,
  `validate`.
- Return only failures from this application's catalog. A dependency's failure must be translated.

## Standard codes

| Code | Status | Retryable | Typical cause |
| --- | --- | --- | --- |
| `INVALID_INPUT` | 400 | No | Schema refusal with `data.issues` (≤ 10 `{ path, message }`, JSON Pointers); repeated query key; bad JSON |
| `UNAUTHORIZED` | 401 | No | Missing/invalid token, bad RPC props or principal, invalid proof |
| `FORBIDDEN` | 403 | No | Missing scope, ineligible actor, absent authority for conditional scopes, proof not admitting the call |
| `NOT_FOUND` | 404 | No | No route (before authentication), unpinned origin |
| `HTTP_METHOD_NOT_ALLOWED` | 405 | No | Non-GET on health or a `tokens.resources` path, non-GET/HEAD on assets |
| `REQUEST_TOO_LARGE` | 413 | No | Body over its limit |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | No | Non-JSON body; content-encoded byte upload |
| `RATE_LIMITED` | 429 | Yes (60 s) | The configured rate limit |
| `INTERNAL_ERROR` | 500 | No | Unexpected error or invalid result |
| `OUTCOME_UNKNOWN` | 502 | No | Returned by handlers: a write may have happened |
| `UPSTREAM_UNAVAILABLE` | 503 | Yes | Returned by handlers |
| `UPSTREAM_TIMEOUT` | 504 | Yes | Returned by handlers |

## Presentation

HTTP: the catalog status, the envelope, `Retry-After` for `retryAfter`. MCP: a tool result with
`isError: true` and the failure JSON. RPC: the `Result` itself. The typed client returns the envelope,
or with `response: 'data'` throws an `Error` whose `cause` is `{ status, failure, requestId }`.

## Uncertain outcomes and retries

- `retryable: true` only when the same call may succeed later (rate limit, outage, timeout).
- When a write may have been applied and its answer was lost, return
  `errors.outcomeUnknown.create()`. Callers reconcile (read the resource, poll an operation) before
  repeating anything. Record intent before provider writes and use idempotency keys where possible.
- Never retry uncertain writes or paid provider calls blindly; never turn an outage into an empty
  success.
- `data` holds finite codes, counts, positions and field paths. Never submitted values, credentials
  or provider bodies.
