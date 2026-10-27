# Errors and results

Handlers return a `Result`. Expected failures are values from the application's error catalog, and
every transport presents them the same way. This guide covers declaring failures, returning them, and
the cases where the outcome of a write is unknown.

## Results

```ts
import { err, ok } from '@arbol-ai/maximus';
import type { Failure, Result } from '@arbol-ai/maximus';

type Lookup = Result<{ noteId: string }, Failure>; // { ok: true, value } | { ok: false, error }

return ok({ noteId });
return err(errors.noteNotFound.create());
```

The shared execution path checks the shape strictly: exactly `ok` plus `value` or `error`. A handler
that returns anything else answers `INTERNAL_ERROR`.

## The error catalog

```ts
import { defineErrors, t } from '@arbol-ai/maximus';

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
```

| Field                | Meaning                                                                                                                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| key (`noteNotFound`) | The factory name in code. Standard names (`invalidInput`, `notFound`, …) and the catalog's own members (`schema`, `definitions`, `status`, `retryAfter`, `validate`) are reserved: the type and `defineErrors` refuse them. |
| `code`               | A stable `UPPER_SNAKE_CASE` identifier. Unique across the catalog, standard codes included.                                                                                                                                 |
| `status`             | The HTTP status, 400–599.                                                                                                                                                                                                   |
| `message`            | A fixed, human-readable sentence. It is part of the contract; it never carries values.                                                                                                                                      |
| `retryable`          | Whether repeating the same call may succeed. Defaults to `false`.                                                                                                                                                           |
| `retryAfter`         | Seconds, sent as `Retry-After` over HTTP.                                                                                                                                                                                   |
| `dataSchema`         | A strict object schema for structured `data`. Without it, `data` is `{}`.                                                                                                                                                   |

The catalog includes the framework's [standard failures](../reference/standard-failures.md), so
`errors.notFound`, `errors.forbidden`, `errors.outcomeUnknown` and the others are always there.
`standardErrors` is the catalog with nothing added, convenient in shared code.

Each factory offers:

- `create()` or `create(data)`: the failure value. With a `dataSchema`, `data` is required (unless
  every field is optional) and checked against the schema.
- `is(value)`: whether a value is exactly this failure.
- `schema`: its TypeBox schema.

The catalog itself offers `status(code)`, `retryAfter(code)`, `definitions`, `schema` (the union of
every failure) and `validate(value)`.

## Returning failures

```ts
async ({ env, principal }, input) => {
  const note = await readNote(env.NOTES, noteKey(principal.organizationId, input.noteId));
  return note ? ok(note) : err(errors.noteNotFound.create());
};
```

Return only failures from your own catalog. Every returned failure is validated against it: code,
message, retryability and data must match a definition exactly. A failure from another catalog, a
hand-built object or a changed message answers `INTERNAL_ERROR`. Preparation (`derive`) and
middleware failures are validated the same way.

Keep `data` small and finite: codes, counts, positions and field paths. Never put submitted values,
credentials or provider response bodies in it.

## Throwing

Throw only for the unexpected. A thrown error, an invalid output or an output above its byte limit
answers `INTERNAL_ERROR`, and Maximus reports it to diagnostics as `maximus.unexpected` with the
error's name, cause names and source locations, never its message. The invalid value is not sent.

To report an error you handled yourself, call `reportUnexpected(error, surface, requestId)`.

## Invalid input

A refused input answers `INVALID_INPUT` on every transport with up to ten issues:

```json
{
  "code": "INVALID_INPUT",
  "message": "The request does not match the published schema.",
  "retryable": false,
  "data": {
    "issues": [
      { "path": "/items/1/sku", "message": "Expected string to match '^[A-Z]{3}-[0-9]{3}$'" },
      { "path": "/organizationId", "message": "Unexpected property" }
    ]
  }
}
```

`path` is the RFC 6901 JSON Pointer of the refused field (empty for the whole input) and `message`
names what was expected. Schema messages never contain the input's values; the messages you give
`refineSchema` and `inspectSchema` travel the same way, so they must not either. A person, a client
or a model can correct the input from the issues alone. Transport-level refusals, such as a repeated
query key or a malformed JSON body, carry no issues.

## Presentation on each transport

| Transport  | Success                                                              | Failure                                                                                                    |
| ---------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| HTTP       | `successStatus` and `{ success: true, data, error: null, metadata }` | The catalog status and `{ success: false, data: null, error, metadata }`, plus `Retry-After` when declared |
| MCP        | `structuredContent`                                                  | A tool result with `isError: true` and the failure as JSON text                                            |
| Native RPC | `{ ok: true, value }`                                                | `{ ok: false, error }`                                                                                     |

## Retries

`retryable: true` means the same call may succeed later: a rate limit, an upstream outage, a timeout.
A client may retry those, with backoff and `Retry-After`. Everything else is final until something
changes: the input, the caller's permissions, the resource.

`RATE_LIMITED` uses the application's `rateLimit.retryAfter` (60 seconds by default) for its
`Retry-After`.

## Uncertain outcomes

When a write may have happened but its answer was lost (a provider timed out after receiving the
request, a dependency call threw midway), answer `OUTCOME_UNKNOWN`:

```ts
try {
  await provider.createBooking(request);
} catch {
  return err(errors.outcomeUnknown.create()); // 502, never retryable
}
```

`OUTCOME_UNKNOWN` is never retryable. The caller reconciles first: it reads the resource or polls an
operation, and only then decides whether to repeat anything. Design writes so they can be
reconciled: record intent before calling a provider, use idempotency keys where the provider supports
them, and give every pending operation a readable state.

Two rules apply everywhere:

- Never retry an uncertain write blindly, and never retry a paid or rate-limited provider call
  without a persisted budget.
- Never turn a failure into a successful empty answer. An outage is a failure, not an empty list.

## Failures of other services

A dependency's failures belong to its catalog. When you call another service, translate its failures
into yours:

```ts
const { error } = quote;
if (error.code === 'UNKNOWN_SKU' && 'index' in error.data && typeof error.data.index === 'number') {
  return err(errors.unknownItem.create({ index: error.data.index }));
}
return err(error.retryable ? errors.upstreamUnavailable.create() : errors.internal.create());
```

Or declare the same definitions in both catalogs: export the definitions object and spread it into
each one, `defineErrors({ ...sharedDefinitions, noteNotFound: { … } })`.

A client that presents another service's failures without importing its code reads the failure
responses of that service's OpenAPI document (each status names the codes that answer with it), or
`STANDARD_FAILURES` from `@arbol-ai/maximus/failures` for the framework's own.
