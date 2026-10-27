# Errors and results

## The catalog

`errors.ts` declares the service's own failures. Each has a fixed code, HTTP status and message; the catalog
also holds every standard failure.

```ts
// errors.ts
import { defineErrors, t } from '@arbol-ai/maximus';

export default defineErrors({
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
```

- A code is uppercase words joined by underscores, unique among the catalog's codes, the standard ones
  included. A status is from 400 to 599. A message is fixed and never holds a value.
- `retryable` says whether the same request may succeed later; `retryAfter` sends `Retry-After` seconds.
- `dataSchema` is a strict object: the `data` a failure of that code carries. Put codes, counts, positions
  and field paths in it, never a submitted value, a credential or another service's answer.
- The standard failures' names (`invalidInput`, `unauthorized`, `forbidden`, `notFound`, `methodNotAllowed`,
  `tooLarge`, `unsupportedMedia`, `rateLimited`, `internal`, `upstreamUnavailable`, `upstreamTimeout`,
  `outcomeUnknown`) and the catalog's members (`schema`, `definitions`, `status`, `retryAfter`, `validate`) are
  reserved keys.

`defineErrors` throws a `TypeError` for a rule it refuses.

## Answer a failure

A handler, `context.ts` or a tool answers an expected failure with `fail(code)`:

```ts
const note = await notes.find(input.noteId);
if (!note) {
  return fail('NOTE_NOT_FOUND');
}
```

A code that declares data takes it: `return fail('QUOTA_EXCEEDED', { limit: 100 });`.

A route lists the domain codes it may answer in `failures`: `failures: ['NOTE_NOT_FOUND']`. `fail` then
type-checks only those codes and the standard ones an operation answers itself, the OpenAPI document lists
them, and any other domain
failure, from the handler, `context.ts` or middleware, answers `INTERNAL_ERROR` and is reported. Without
`failures`, every code of the catalog is allowed and listed.

Throw only for what should never happen. A throw, an output its schema refuses or over its limit, or a code
outside the catalog answers `INTERNAL_ERROR`, never the error's text, and is reported as `maximus.unexpected`
by the error's name alone.

## Standard failures

Every catalog holds these, and an operation answers them without listing them, except five. Routing and
admission alone answer `NOT_FOUND`, `HTTP_METHOD_NOT_ALLOWED` and `UNAUTHORIZED`. Admission answers
`REQUEST_TOO_LARGE` and `UNSUPPORTED_MEDIA_TYPE` for a JSON body, and a byte route returns them as
`body.read()` gives them. `fail` takes none of the five; an operation that answers one in any other way
answers `INTERNAL_ERROR` instead.

| Code                      | Status | Retryable | When                                                                                                                                                        |
| ------------------------- | ------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_INPUT`           | 400    | No        | The input does not match its schema; `data.issues` lists up to ten `{ path, message }`.                                                                     |
| `UNAUTHORIZED`            | 401    | No        | No valid token; RPC props or principal refused.                                                                                                             |
| `FORBIDDEN`               | 403    | No        | The token lacks the scope, the actor kind is not admitted.                                                                                                  |
| `NOT_FOUND`               | 404    | No        | No route answers the method and path, before any token is read.                                                                                             |
| `HTTP_METHOD_NOT_ALLOWED` | 405    | No        | A method the health path, discovery, a page or a web app's file does not answer, such as `POST /health`; on an API route an unserved method is `NOT_FOUND`. |
| `REQUEST_TOO_LARGE`       | 413    | No        | The body exceeds its limit.                                                                                                                                 |
| `UNSUPPORTED_MEDIA_TYPE`  | 415    | No        | A body that is not JSON, or a compressed byte upload.                                                                                                       |
| `RATE_LIMITED`            | 429    | Yes, 60 s | The rate limit refused the caller.                                                                                                                          |
| `INTERNAL_ERROR`          | 500    | No        | Anything unexpected.                                                                                                                                        |
| `OUTCOME_UNKNOWN`         | 502    | No        | A write may have happened and its answer was lost.                                                                                                          |
| `UPSTREAM_UNAVAILABLE`    | 503    | Yes       | A service this one depends on could not answer.                                                                                                             |
| `UPSTREAM_TIMEOUT`        | 504    | Yes       | A service this one depends on did not answer in time.                                                                                                       |

A handler answers the last three itself, with `fail('UPSTREAM_UNAVAILABLE')` for instance.

## On each transport

- HTTP: the code's status and `{ success: false, data: null, error, metadata: { requestId } }`, with
  `Retry-After` when the code has one.
- MCP: a tool result with `isError: true` whose text is the failure.
- RPC: the `Result` `{ ok: false, error }`.

The failure is `{ code, message, retryable, data }` on all three.

## Uncertain outcomes and retries

- `retryable: true` only when the same call may succeed later: a rate limit, an outage, a timeout.
- When a write may have been applied and its answer was lost, answer `OUTCOME_UNKNOWN`. The caller reconciles
  (reads the resource, looks for the id it chose) before repeating anything. Record intent before a provider
  write and give writes stable keys, such as an id the caller chooses.
- Never retry an uncertain write or a paid provider call blindly, and never turn an outage into an empty
  success.

## Failures of other services

A failure another service answers belongs to that service's catalog, not to this one. Translate it before
answering: a failure the caller can fix becomes one of this catalog's codes, one that may pass becomes
`UPSTREAM_UNAVAILABLE`, and the rest `INTERNAL_ERROR`. A code outside this catalog fails its check and
answers `INTERNAL_ERROR`. Catch a call that throws, such as an RPC call to a Worker that cannot be reached:

```ts
import type { Quote, QuoteItemsFailure } from '#maximus/services/pricing';

let priced: Result<Quote, QuoteItemsFailure>;
try {
  priced = await env.PRICING.quoteItems(principal, input);
} catch {
  return fail('UPSTREAM_UNAVAILABLE');
}
if (priced.ok) {
  return { currency: priced.value.currency, totalCents: priced.value.totalCents };
}
const failure = priced.error;
if (failure.code === 'UNKNOWN_SKU') {
  return fail('UNKNOWN_ITEM', { index: failure.data.index });
}
if (failure.retryable) {
  return fail('UPSTREAM_UNAVAILABLE');
}
return fail('INTERNAL_ERROR');
```

The owner's failure types come from the RPC document it publishes, so the code narrows `data`. Answer only
what this catalog declares: never return the owner's value or failure as it is.

See [Errors and results](https://github.com/getarbol/maximus/blob/main/docs/guides/errors-and-results.md)
and [Standard failures](https://github.com/getarbol/maximus/blob/main/docs/reference/standard-failures.md).
