# Capture

Observers and logs keep metadata alone. Capture is the one destination for content: a service declares a
store, and every operation call and every refusal, on every transport, becomes one complete record in it,
with its caller, its timing, what it answered and, when the service says so, its input and output. A field
whose schema says `secret: true` never reaches it, and neither does a token, a raw request body or an
attachment's bytes.

The record is written beside the same two points that feed observers, so it always states what the caller
received: including the refusals a middleware never sees (a bad token, the rate limit, a missing scope, an
input its schema refuses) and the output checks a middleware runs before.

## Declare it

A project declares capture in `capture.ts` at its root, and the stream in `vite.config.ts`:

```ts
// capture.ts
import { defineCapture, pipeline } from '@arbol-ai/maximus/capture';

export default defineCapture({
  enabled: (env) => env.CAPTURE !== 'off',
  sink: pipeline({ binding: 'EVENTS', blobs: 'EVENT_BLOBS' }),
  payloads: 'all',
  dimensions: ({ context }) => ({ agentId: context.agent?.id }),
});
```

```ts
// vite.config.ts: inside maximus()
env: {
  EVENTS: bindings.pipeline({ name: 'events_v1' }),
  EVENT_BLOBS: bindings.r2({ name: 'event-blobs' }),
},
```

A Worker composed by hand passes the same object to the builder: `maximus<Env>({ …, capture })`.

| Field        | Default | Effect                                                                                                                                                                                                                                     |
| ------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sink`       | None    | Where records go: `pipeline()`, or an object of your own. See [Sinks](#sinks). Required.                                                                                                                                                   |
| `enabled`    | On      | `true`, `false` or a function of `env`, decided for each call. It is apart from `telemetry.enabled`: turning one off leaves the other on. A function that throws turns capture off for that call and logs `maximus.capture.switch_failed`. |
| `payloads`   | `none`  | `all` also records each decoded input, checked output and failure data, without what their schemas mark. `none` records the metadata alone.                                                                                                |
| `dimensions` | None    | What the call is about, in your words. See [Dimensions](#dimensions).                                                                                                                                                                      |

`defineCapture` refuses any other field, and `.build()` a sink that cannot send. Like the other root modules,
`capture.ts` imports nothing that loads only in workerd. Without a third argument to the handler, as in a
test, or while capture is off, a call records nothing.

## Mark what never leaves

A schema marks a field with `secret: true`:

```ts
input: {
  username: t.String(),
  password: t.String({ secret: true }),
  logins: t.Array(t.Object({ user: t.String(), totpSecret: t.String({ secret: true }) }, { additionalProperties: false })),
},
```

The mark applies to an output and to a failure's `dataSchema` as well, and to whatever the marked schema
holds: `t.Array(t.String(), { secret: true })` removes the whole field. It changes nothing else: the caller
still receives its output, the handler its input, and no OpenAPI document or tool listing carries the word, so
marking a field changes no published contract.

`withoutSecrets(schema, value)`, from `@arbol-ai/maximus/schemas` and from this entry, is what capture calls.
It answers a copy, at any depth: through objects, records, arrays, tuples, unions, intersections, optional
fields and references. The value it was given never changes. A marked list item goes with its value, a marked
tuple position becomes `null`, and a schema marked at its root answers `undefined`.

It fails closed wherever a schema cannot speak for a value:

- A name marked in any member of a union is removed from all of them. Reading which member a value belongs
  to would depend on checks that a missing format makes fail in silence.
- A key a strict object refuses is removed, even if something added it after the check.
- A value of a type its schema does not admit is removed, and so is one under a `$ref` the schema does not
  define.

### Codecs

An input codec can move a value to where no mark reaches, so an input whose schema has both codecs and a
mark is recorded as its schema checked it, defaults applied, before the codecs ran. An input without a mark is
recorded decoded, as the handler received it.

Mark a field where the wire carries it. `pipeSchema(source, target)` and `inputSchema(schema, wire)` throw a
`TypeError` when the canonical schema marks a field and the wire schema marks none. A wire schema that gives a
secret another name must mark it under that name too.

## What a record holds

`CaptureRecordSchema` is the record's schema, and `CaptureRecord` its type. Each field is present on every
record, `null` where the call never reached it. The first thirteen are the fields of an analytics event, by the
same names, so live counters and a store of records agree.

| Field             | Value                                                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`              | This record and no other: a UUIDv7, so ids sort by time. A sink that retries keeps it; a consumer deduplicates on it.                                          |
| `service`         | The application's name.                                                                                                                                        |
| `operation`       | The operation's name; `null` when a refusal names none. A requested path never travels.                                                                        |
| `organizationId`  | The verified caller's organization; `null` before verification.                                                                                                |
| `actorId`         | The verified caller, as its token states it: unlike analytics, never a pseudonym.                                                                              |
| `actorKind`       | `user` or `service`.                                                                                                                                           |
| `requestId`       | The request's id, the one in `x-request-id`. An MCP batch shares one, and RPC forwards it, so it does not identify a record.                                   |
| `traceId`         | What `telemetry.traceId` returns, or `null`.                                                                                                                   |
| `surface`         | `http`, `mcp` or `rpc`.                                                                                                                                        |
| `occurredAt`      | When the call finished, in Unix milliseconds.                                                                                                                  |
| `durationMicros`  | How long execution took, or admission for a refusal.                                                                                                           |
| `outcome`         | `success` when the caller received its output, `failure` when it received a failure.                                                                           |
| `errorCode`       | The failure's code, or `null`.                                                                                                                                 |
| `stage`           | `admission` for a refusal before the shared execution path, `execution` from there on, as observers tell them apart.                                           |
| `version`         | The application's version.                                                                                                                                     |
| `effect`          | The operation's `read`, `write` or `delete`.                                                                                                                   |
| `scopes`          | The scopes the operation declares.                                                                                                                             |
| `visibility`      | `public` or `internal`.                                                                                                                                        |
| `httpMethod`      | On HTTP, the route's method.                                                                                                                                   |
| `httpPath`        | On HTTP, the route's path template: `/v1/notes/{noteId}`.                                                                                                      |
| `mcpTool`         | On MCP, the tool's name.                                                                                                                                       |
| `rpcCaller`       | Over RPC, the caller of the Service Binding, as admission checked it or, when it refused the binding, as the binding claimed.                                  |
| `clientId`        | The OAuth client the verified token was issued to.                                                                                                             |
| `clientClass`     | `human`, `machine` or `dcr`.                                                                                                                                   |
| `grantedScopes`   | The scopes the verified token grants.                                                                                                                          |
| `userAgent`       | On HTTP and MCP, the request's `user-agent`, cut to 200 characters. It tells a CLI from a browser; it is what the caller claims.                               |
| `tokenSha256`     | The hex SHA-256 of the verified token: it joins the calls of one session, and the token never travels. A refused token is never read.                          |
| `dimensions`      | What the `dimensions` callback named.                                                                                                                          |
| `startedAt`       | When the transport began admitting the call.                                                                                                                   |
| `admissionMicros` | How long admission took.                                                                                                                                       |
| `input`           | Under `payloads: 'all'`, the input as [above](#codecs); `null` for a refused input.                                                                            |
| `output`          | Under `payloads: 'all'`, the checked output as the caller received it, without its secrets. For an attachment, its `contentType`, `filename` and `byteLength`. |
| `failureData`     | Under `payloads: 'all'`, the failure's data without its secrets: for `INVALID_INPUT`, its `issues`, which never hold the refused values.                       |
| `payloadRef`      | `{ $ref, bytes, sha256 }` when a sink wrote the three fields above elsewhere; they are then `null`.                                                            |

A byte body, the token and every other header stay out of it. A handler or `context.ts` reads the same
`rpcCaller` and `userAgent` from its invocation.

## Dimensions

`dimensions` says what a call is about, in identifiers only your service knows: an agent, a contact, a
conversation. It receives `env`, `operation`, `surface`, `principal`, `authority` without its token, `rpcCaller`,
`userAgent`, the prepared `context` and the decoded `input`, and answers an object of strings, of at most 256
characters each, of which the record keeps the first 32. Any other value is left out.

`context` is empty when the call was refused before it was prepared, and `input` absent. It runs as background
work, so read what the call already knows and start nothing. One that throws leaves the record without
dimensions and logs `maximus.capture.dimensions_failed`.

`defineCapture<PreparedContext<typeof context>>` types `context`, importing the context's type alone.

## Sinks

`pipeline({ binding, map?, blobs? })` sends each record to a Cloudflare Pipelines stream:

- **While the env has no such binding**, a call builds no record and logs nothing, so a preview without the
  stream costs nothing.
- **`map`** turns a record into the row the stream's schema expects, and may be async. A structured stream drops
  a row its schema refuses, so a stream of any other shape needs it:
  `map: (record, env) => ({ event_id: record.id, environment: env.ENVIRONMENT, … })`. Answering `null` or
  `undefined` sends nothing, such as for a refusal that names no operation.
- **A send that fails is retried once**, after 200 ms, with the same id.
- **`blobs`** names an R2 binding for what the stream cannot take. A row refused twice is written to
  `dlq/<service>/<yyyy-mm-dd>/<id>.json`, for your own job to send again. An `input`, `output` and `failureData`
  over 900 KB together, measured in bytes, are written to `payloads/<organizationId>/<id>.json`, and the record
  carries `payloadRef`. Without `blobs`, both are failed deliveries.

`queue({ binding, blobs? })` sends each record to a Cloudflare Queue as one JSON message, and leaves retries and
the dead letter to the queue:

```ts
// capture.ts
import { defineCapture, queue } from '@arbol-ai/maximus/capture';

export default defineCapture({
  enabled: (env) => env.CAPTURE !== 'off',
  sink: queue({ binding: 'CAPTURE_QUEUE', blobs: 'CAPTURE_BLOBS' }),
  payloads: 'all',
});
```

```ts
// vite.config.ts: inside maximus()
env: {
  CAPTURE_QUEUE: bindings.queue({ name: 'capture' }),
  CAPTURE_BLOBS: bindings.r2({ name: 'capture-blobs' }),
},
```

- **While the env has no such binding**, a call builds no record and logs nothing.
- **The sink sends once.** A queue keeps a message it accepted and delivers it at least once; a send it refuses
  is a failed delivery. Retries and the dead letter belong to the queue's consumer: a Worker of its own, such
  as a lake's ingest, whose `triggers.queue({ name, maxRetries, deadLetterQueue })` says how often a message it
  fails is retried before it moves to the dead letter queue. The consumer writes each record to the store,
  deduplicating on its `id`, and acknowledges it.
- **A message holds 128 KB**: an `input`, `output` and `failureData` over 96 KB together are written to `blobs`
  by reference, as `pipeline` does. Without `blobs`, such a record is a failed delivery.

Any object with `send(record, env)` is a sink, and `available(env)` may say when it cannot take records. Capture
itself never retries: `pipeline` retries because a stream takes a repeated row and a consumer deduplicates on the
id, and `queue` leaves retries to its consumer. A sink whose append can lose its outcome should not retry at
all.

## What delivery costs and promises

Nothing of this reaches the caller. The record is built and sent on a timer after the response, inside the call's
`waitUntil`, in a promise of its own: it can delay neither the response nor an observer, and neither can fail the
other. The only work added to the isolate is walking and encoding what Maximus already bounds, 32 KiB in and
256 KiB out unless an operation raises its limits.

A failed delivery logs `maximus.capture.delivery_failed` with the request id alone, and the call has already
answered. Background work is best effort: an evicted isolate loses what it had not sent, so compare the records
with the invocations your logs hold. A fact that must never be lost belongs in the database, in the same
transaction as the change.

## Test it

Tests stand in for the binding, and pass the third argument that keeps background work:

```ts
const sent: unknown[] = [];
const work: Promise<unknown>[] = [];
await handler(
  request,
  { ...env, EVENTS: { send: async (rows) => sent.push(...rows) } },
  {
    waitUntil: (promise) => work.push(promise),
  }
);
await Promise.all(work);
```

Keep one test per marked field: that its value appears in no record is what `secret: true` promises.

## The rule it keeps

Observers still receive metadata alone, and logs, errors and traces carry no input or output. Capture is a
separate, declared destination, which the owner authorized on 3 November 2026: content reaches a store through
it, and never through a log line.
