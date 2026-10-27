# Errors and results

This guide covers the failures a service answers: the error catalog in `errors.ts`, answering a failure
with `fail`, declaring the failures a route may answer and what becomes of any other, retries, outcomes a
caller cannot be sure of, and how each transport presents a failure. Read it when you add a failure, or
when a route calls something that can fail.

## The error catalog

A failure is a value, `{ code, message, retryable, data }`, and every failure a service answers comes from
its catalog. `errors.ts`, at the project's root, default-exports it:

```ts
// errors.ts
import { defineErrors, t } from '@arbol-ai/maximus';

/** The notes service's own failures: `fail` and `failures` take their codes. */
export default defineErrors({
  noteNotFound: { code: 'NOTE_NOT_FOUND', status: 404, message: 'The note does not exist.' },
  noteQuotaReached: {
    code: 'NOTE_QUOTA_REACHED',
    status: 409,
    message: 'The organization has reached its note quota.',
    dataSchema: t.Object({ limit: t.Integer({ minimum: 0 }) }, { additionalProperties: false }),
  },
  planEnded: { code: 'PLAN_ENDED', status: 403, message: "The organization's plan has ended." },
  searchIndexBusy: {
    code: 'SEARCH_INDEX_BUSY',
    status: 503,
    message: 'The search index is being rebuilt. Try again shortly.',
    retryable: true,
    retryAfter: 30,
  },
});
```

| Field                | Meaning                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| key (`noteNotFound`) | The failure's name in code, as in `errors.noteNotFound.create()`.                                |
| `code`               | The stable code clients branch on: uppercase words joined by underscores, unique in the catalog. |
| `status`             | The HTTP status that answers it, from 400 to 599.                                                |
| `message`            | A fixed sentence for people. It is part of the contract and never carries values.                |
| `retryable`          | Whether the same call may succeed later; `false` unless declared.                                |
| `retryAfter`         | The seconds a client waits before trying again, sent as `retry-after` over HTTP.                 |
| `dataSchema`         | A strict object schema of the failure's `data`. Without one, `data` is `{}`.                     |

The catalog also holds the [standard failures](../reference/standard-failures.md), such as
`INVALID_INPUT`, `NOT_FOUND` and `INTERNAL_ERROR`, which every operation may answer. Without `errors.ts`, they
are the whole catalog. `defineErrors` refuses a catalog that breaks a rule:

- A code that is not uppercase words joined by underscores, at most 81 characters:
  `An error code is uppercase words joined by underscores, such as RECORD_NOT_FOUND: note-not-found`
- A code used twice, a standard one included, or a status outside 400 to 599:
  `Error definitions require unique codes and failure statuses.`
- A `dataSchema` that is not a strict object: `Domain error data must be a strict object schema.`
- A name a standard failure (`notFound`, `invalidInput`, …) or the catalog itself (`schema`, `definitions`,
  `status`, `retryAfter`, `validate`) already uses:
  `Domain errors cannot replace framework errors or catalog members.`

The OpenAPI document lists each code with its message under its status, so the catalog is part of the API
your callers read.

## Answer a failure

A handler answers a failure with `fail(code)`, or `fail(code, data)` when the code declares data, and returns
what `fail` returns. This is the DELETE route of the [`d1-notes`](../../examples/d1-notes) example:

```ts
// routes/v1/notes/[noteId].delete.ts
import { defineHandler, UuidSchema } from '@arbol-ai/maximus';

/** DELETE /api/v1/notes/{noteId}: answers the empty object once the note is gone. */
export default defineHandler(
  async ({ input, notes, fail }) => {
    const wasDeleted = await notes.delete(input.noteId);
    if (!wasDeleted) {
      return fail('NOTE_NOT_FOUND');
    }
  },
  {
    description: 'Delete a note of the organization.',
    input: { noteId: UuidSchema },
    failures: ['NOTE_NOT_FOUND'],
  }
);
```

`fail` is typed by the catalog: it accepts the codes the route may answer, and the data each code's
`dataSchema` declares, required unless all of its fields are optional. This call answers the JSON below,
with the status `409`:

```ts
return fail('NOTE_QUOTA_REACHED', { limit: 1000 });
```

```json
{
  "success": false,
  "data": null,
  "error": {
    "code": "NOTE_QUOTA_REACHED",
    "message": "The organization has reached its note quota.",
    "retryable": false,
    "data": { "limit": 1000 }
  },
  "metadata": { "requestId": "…" }
}
```

An expected outcome is answered, never thrown. Keep `data` small and bounded: codes, counts, positions and
field paths. Never put a submitted value, a credential or a provider's answer in it.

`context.ts` receives `fail` as well, to answer the call before any handler runs:

```ts
// context.ts
import { defineContext } from '@arbol-ai/maximus';

import { noteStore } from '#src/notes.ts';

/** What every handler receives: the notes of the caller's organization, unless its plan has ended. */
export default defineContext(async ({ env, principal, fail }) => {
  const plan = await env.NOTES_DB.prepare('SELECT status FROM plans WHERE organization_id = ?')
    .bind(principal.organizationId)
    .first<{ status: string }>();
  if (plan?.status === 'ended') {
    return fail('PLAN_ENDED');
  }
  return { notes: noteStore(env.NOTES_DB, principal.organizationId) };
});
```

## Declare a route's failures

`failures` lists the domain failures a route may answer, each once, besides the standard ones:

- `fail` then accepts only those codes and the standard ones an operation may answer, as a type.
- The OpenAPI document lists only those and the standard failures for the route.
- Any other domain failure the route answers, from its handler, from `context.ts` or from operation
  middleware, is the service's error. The caller receives `500 INTERNAL_ERROR`, never the undeclared code,
  and the error is reported as `maximus.unexpected` by its safe description: its name, its causes' names
  and its source locations, never its message.

So a route that lists its failures answers a code of `context.ts` only when it lists that code too:
`failures: ['NOTE_NOT_FOUND', 'PLAN_ENDED']`. A route that declares no `failures` may answer, and documents,
every failure of the catalog.

`.build()` refuses a list with a code the catalog lacks, a standard code or a repeated one:
`Operation "deleteNote": failures lists each domain failure code of the error catalog once; standard failures are always allowed.`

Every failure is also checked against the catalog itself. A code the catalog does not define, a message,
`retryable` or `data` that differs from its definition, or a `fail` whose data its `dataSchema` refuses, is
the service's error too, and answers `INTERNAL_ERROR`.

## Standard failures

The standard failures are the ones Maximus answers itself, for a refused token, a scope the token lacks, an
unknown route, an input its schema refuses, a body beyond its limit, the rate limit and the service's own
errors, and three that only handlers answer: `UPSTREAM_UNAVAILABLE`, `UPSTREAM_TIMEOUT` and
`OUTCOME_UNKNOWN`. A handler and `context.ts` answer any of them with `fail`, whatever the route's
`failures` list, except five. Routing and admission alone answer `NOT_FOUND`, `HTTP_METHOD_NOT_ALLOWED` and
`UNAUTHORIZED`, before an operation runs. `REQUEST_TOO_LARGE` and `UNSUPPORTED_MEDIA_TYPE` are answered
when a body is read: admission reads a JSON body, and a byte route returns the failure its body's `read()`
gives, as it is. `fail` accepts none of the five; an operation that answers one in any other way answers
`INTERNAL_ERROR` instead. [Standard failures](../reference/standard-failures.md) gives each one's status,
message, data and when it is answered.

## Invalid input

An input its schema refuses answers `INVALID_INPUT` on every transport, with up to ten issues:

```json
{
  "code": "INVALID_INPUT",
  "message": "The request does not match the published schema.",
  "retryable": false,
  "data": {
    "issues": [
      { "path": "/title", "message": "Expected string length greater or equal to 1" },
      { "path": "/archived", "message": "Unexpected property" }
    ]
  }
}
```

`path` is the RFC 6901 JSON Pointer of the refused field, empty for the whole input, and `message` names
what was expected. Neither contains the input's values; a `path` names fields alone, which for an
unexpected property is the key the caller sent. The issues reach only the caller's answer, never a log
event or an observation. The messages you give `refineSchema` and `inspectSchema` travel the same way, so
they must not contain values either. A person, a client or a model can correct the
input from the issues alone. A request refused before its input is decoded, for a repeated query key or a
body that does not parse, answers `INVALID_INPUT` without issues.

## Unexpected errors

Throw only for the unexpected. A handler that throws, returns an output its schema refuses or an output
beyond its limit answers `500 INTERNAL_ERROR`: the caller never receives the error's text or the refused
value. Maximus reports the error as `maximus.unexpected` with its safe description and the request's id, as
[Observability](observability.md) describes. To report an error you handled yourself, call
`reportUnexpected(error, surface, requestId)` from `@arbol-ai/maximus`.

## Results

An operation declared with the builder, and every native RPC method, answers a `Result`: `ok(value)` or
`err(failure)`, where the failure comes from the catalog's factory:

```ts
import { err, ok } from '@arbol-ai/maximus';

base.operation('getNote', definition, async ({ notes }, input) => {
  const note = await notes.find(input.noteId);
  if (!note) {
    return err(errors.noteNotFound.create());
  }
  return ok(note);
});
```

A Result is exactly `{ ok: true, value }` or `{ ok: false, error }`, and the execution path refuses any other
shape as the service's error. A route's handler never returns a Result: it answers its output or
`fail(code)`. [Worker composition](worker-composition.md) shows the builder.

Each failure of a catalog offers:

- `create()`, or `create(data)` for a code that declares data: the failure, its data checked against its
  `dataSchema`.
- `is(value)`: whether a value is exactly this failure.
- `schema`: its strict TypeBox schema.

The catalog offers `status(code)`, `retryAfter(code)`, `definitions`, `schema`, the union of every
failure, and `validate(value)`, which answers the failure or throws. `standardErrors` is the catalog of the
standard failures alone.

`isResult(value)` tells whether an answer you did not produce, such as another Worker's, is a Result with a
well-formed failure, and `resultSchema(value, error)` builds the schema of a Result to check one entirely.
`STANDARD_FAILURES`, from `@arbol-ai/maximus/failures`, lists the standard failures as plain data, for code
that presents them without the runtime, such as a gateway.

## Retries

`retryable: true` means the same call may succeed later: a rate limit, an upstream outage, a deadline. A
client may repeat those calls, with backoff and after any `retry-after`. Every other failure is final until
something changes: the input, the caller's permissions or the resource.

`RATE_LIMITED`, `UPSTREAM_UNAVAILABLE` and `UPSTREAM_TIMEOUT` are the retryable standard failures. A domain
failure is retryable when its definition says so, and `retryAfter` sends its wait as `retry-after`.
`RATE_LIMITED` sends the `retryAfter` of the application's `rateLimit`, 60 seconds by default. A
`retry-after` never makes repeating a write safe.

## Uncertain outcomes

When a write may have happened but its answer was lost, because a provider broke the connection after
receiving the request or a dependency failed midway, answer `OUTCOME_UNKNOWN`. In a handler that schedules a
reminder for a note with a provider:

```ts
try {
  await reminders.schedule({ reference: input.noteId, at: input.remindAt });
} catch {
  // The provider may have scheduled the reminder before the connection broke.
  return fail('OUTCOME_UNKNOWN');
}
```

`OUTCOME_UNKNOWN` answers `502` and is never retryable. The caller reconciles first: it reads the resource or
the operation's state, and only then decides whether to repeat anything. Design writes so they can be
reconciled: record the intent before calling a provider, give the provider an idempotency key when it takes
one, and give every pending operation a state a caller can read. The Postgres entry answers
`COMMIT_UNCERTAIN` for a commit whose outcome is unknown, as [Postgres transactions](postgres.md) describes.

Two rules hold everywhere:

- Never repeat an uncertain write blindly, and never retry a paid or rate-limited provider call without a
  budget that outlives the request.
- Never turn a failure into a successful empty answer. An outage is a failure, not an empty list.

## Failures of other services

A dependency's failures belong to its catalog. Translate them into yours: name what the caller can act on,
keep a failure the dependency may recover from retryable, and answer the rest as your own fault. The
`orders` Worker of the [`worker-rpc`](../../examples/worker-rpc) example does so with the failures of the
pricing Worker it calls over RPC:

```ts
// orders/routes/v1/quotes.post.ts
import { defineHandler, t } from '@arbol-ai/maximus';
import type { Result } from '@arbol-ai/maximus';

import type { Quote, QuoteItemsFailure } from '#maximus/services/pricing';
import { OrderItemsSchema } from '#src/items.ts';

/**
 * POST /api/v1/quotes: what an order of these items would cost, as the pricing Worker prices them. Nothing
 * is reserved or charged.
 */
export default defineHandler(
  async ({ env, principal, input, fail }) => {
    let priced: Result<Quote, QuoteItemsFailure>;
    try {
      // The caller's verified principal travels as it is; pricing checks it and the items again.
      priced = await env.PRICING.quoteItems(principal, input);
    } catch {
      return fail('UPSTREAM_UNAVAILABLE');
    }
    if (priced.ok) {
      return { currency: priced.value.currency, totalCents: priced.value.totalCents };
    }
    // Name the item a caller can fix, keep a failure pricing may recover from retryable, and answer the rest,
    // a refusal included, as this service's own fault.
    const failure = priced.error;
    if (failure.code === 'UNKNOWN_SKU') {
      return fail('UNKNOWN_ITEM', { index: failure.data.index });
    }
    if (failure.retryable) {
      return fail('UPSTREAM_UNAVAILABLE');
    }
    return fail('INTERNAL_ERROR');
  },
  {
    description: 'Price the items of a prospective order. Nothing is reserved or charged.',
    effect: 'read',
    input: { items: OrderItemsSchema },
    output: { currency: t.Literal('USD'), totalCents: t.Integer({ minimum: 0 }) },
    failures: ['UNKNOWN_ITEM'],
  }
);
```

`#maximus/services/pricing` is the module `maximus prepare` writes from the RPC document pricing publishes.
Its `QuoteItemsFailure` narrows each failure's `data` by its code, and `fail` checks that data against
`UNKNOWN_ITEM`'s own schema: should pricing answer other data than its document declares, the call answers
`INTERNAL_ERROR`. See [Worker RPC](worker-rpc.md#bind-and-call-the-owner).

Services that share failures can share their definitions instead: export the definitions object and spread
it into each catalog, `defineErrors({ ...sharedDefinitions, noteNotFound: { … } })`.

## On each transport

A failure means the same on every transport; each presents it in its own format:

| Transport | Failure                                                                                                                                                                                                                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP      | The status its definition declares and the envelope `{ success: false, data: null, error, metadata }`, with `retry-after` when the definition declares `retryAfter`, and `www-authenticate` on a `401`                                                                                             |
| MCP       | A tool result with `isError: true` whose text is the failure's JSON, so a model reads its code and issues. A call refused before the MCP server runs, for its token, scope, rate limit or body, answers as HTTP does, and a tool the caller cannot see answers the JSON-RPC error `Tool not found` |
| RPC       | `{ ok: false, error }`                                                                                                                                                                                                                                                                             |

[Wire formats](../reference/wire-formats.md) gives every shape.
