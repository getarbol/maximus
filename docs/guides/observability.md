# Observability

Maximus records enough to find and diagnose any call without recording what the caller sent: a request id
on every answer, a few JSON log events, optional observers, and Cloudflare's own logs and traces. This guide
covers each of them, what they never contain, and how to turn them off.

## Request ids

The Worker gives every request a new UUID, its request id. A caller cannot choose it: an `x-request-id`
or trace header on the request is ignored. The same id appears in:

| Where                                   | As                         |
| --------------------------------------- | -------------------------- |
| Every response, failures included       | The `x-request-id` header  |
| The JSON envelope                       | `metadata.requestId`       |
| A handler's and `context.ts`'s argument | `principal.requestId`      |
| Every log event and observation         | `requestId`                |
| The trace span of an operation call     | The attribute `request.id` |

A caller that reports a problem with its `x-request-id` gives you the key to every record of that request.
Over native RPC, the calling Worker passes its verified principal, request id included, so one id follows a
call from one Worker to the next.

Every response also carries `server-timing: total;dur=<milliseconds>`, the time the Worker spent on it.

Work that outlives the request, such as a queue message, has no request of its own. To correlate it with
the request that started it, store `durableCorrelation(principal.requestId)` from
`@arbol-ai/maximus/diagnostics` with the work. It answers `{ requestId }`, adds `originTraceParent` when you
pass a W3C `traceparent` that parses, and throws a `TypeError` for an id that is neither a UUID nor a
Cloudflare ray id.

## Native log events

Maximus writes one line of JSON per event to the Worker's console, which Workers Logs collect. Each line
names its `event`:

| `event`                            | Level   | Fields besides `event`                                                                                 |
| ---------------------------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `maximus.admission.rejected`       | `warn`  | `service`, `operation`, `requestId`, `traceId`, `surface`, `occurredAt`, `durationMicros`, `errorCode` |
| `maximus.unexpected`               | `error` | `surface`, `requestId` (when known), `name`, `causes`, `issueCount`, `locations`                       |
| `maximus.observer.delivery_failed` | `error` | `requestId`                                                                                            |
| `maximus.telemetry.switch_failed`  | `error` | None                                                                                                   |

**`maximus.admission.rejected`** is written for each request refused before its operation runs: an unknown
path (`NOT_FOUND`), a missing or invalid token (`UNAUTHORIZED`), a missing scope (`FORBIDDEN`), the rate
limit (`RATE_LIMITED`), a body over its limit (`REQUEST_TOO_LARGE`) or one the API cannot read. The MCP
server's own refusals are admissions too: a tool the caller cannot call, or a call over its tool's body
limit. `operation` is `null` when the refusal names none, `surface` is `mcp` at the MCP endpoint and `http`
elsewhere, `occurredAt` is in Unix milliseconds and `durationMicros` is the time from the start of
admission to the refusal. An input that reaches its operation and fails the schema is no admission refusal:
it is the operation's own `INVALID_INPUT`, which observers receive as an execution.

**`maximus.observer.delivery_failed`** is written when an observer's `execution` or `admission` throws or
rejects, and **`maximus.telemetry.switch_failed`** when the function `telemetry.enabled` throws (see
[Turn Maximus's telemetry off](#turn-maximuss-telemetry-off)).

**`maximus.unexpected`** is written when something fails that should not: a handler or `context.ts` that
throws, an output its schema refuses or over its limit, a failure the operation did not declare, a page or
middleware that throws, a cron or queue handler that throws, or an error your code reports.

`maximus.unexpected` describes the error by what is safe to keep:

- `surface`: where it happened. `operation` inside an operation's call; `http` or `mcp` around it;
  `route` in a page; the event's name (`scheduled`, `queue`, `email`) in one of the Worker's other
  handlers, which rethrows the error so the platform retries or records the event as it would; or the
  surface your code names.
- `name`: the error's name when it is a built-in one (`TypeError`, `RangeError`, `SyntaxError`,
  `AbortError`, `TimeoutError` and the other standard errors), `UnknownError` for any other, and `NonError`
  when the value thrown is not an `Error`.
- `causes`: the names of up to three errors along its `cause` chain, nearest first.
- `issueCount`: how many issues its `issues` array holds, or its cause's, as a schema refusal has.
- `locations`: the line and column of up to eight frames of its stack, from the top, without file names.

The caller of a failed call receives `INTERNAL_ERROR`, never the error.

### What a log event never contains

No request or response body, input or output value, header, URL or query string, token, cookie or other
credential, and no error message or stack text. A message is where a value tends to leak, such as an
identifier in a database's refusal, so Maximus keeps the error's name and drops its message.
`maximus.admission.rejected` names neither the actor nor the organization, even when the token was valid; an
`admission` observer receives the verified caller instead (see [Observers](#observers)).

Hold your own log lines to the same rule: codes, ids and counts, never what a caller sent or what a record
holds. For an error your code catches, `reportUnexpected(error, surface, requestId)` from
`@arbol-ai/maximus` writes `maximus.unexpected` with the same description and tells the observers. The
reminders example's queue consumer reports a message it cannot read this way, with
`reportUnexpected(checked.error, 'queue')`, and never logs the message itself (see
[`examples/queue-reminders/queues`](../../examples/queue-reminders/queues)).

`createDiagnostics()` from `@arbol-ai/maximus/diagnostics` gives the same description to code that writes
its own lines: its `describeError(error)` answers the `name`, `causes`, `issueCount` and `locations` above.
Pass it your own error classes' names, `createDiagnostics(['ProviderError'])`, to keep those names instead
of `UnknownError`.

## Turn Maximus's telemetry off

A project states its telemetry in `telemetry.ts` at its root, whose default export is
`defineTelemetry({ enabled, observers, traceId })`; without it, telemetry is on and has no observers. A
Worker composed by hand passes the same fields as `telemetry` to the application builder, `maximus()` from
`@arbol-ai/maximus`.

`enabled` decides whether Maximus writes its log events, calls its observers and annotates trace spans:
`true` by default, `false`, or a function of the Worker's `env` that decides for each call, from a
binding. When it is off, every response still carries its request id. A switch that throws, one that reads
a binding the Worker lacks for instance, turns telemetry off for that call and logs
`maximus.telemetry.switch_failed`; the request still answers.

The switch never stops what Cloudflare collects; [Cloudflare's logs and traces](#cloudflares-logs-and-traces)
has its own control.

## Observers

An observer receives what happens to every call, to count, measure or export it. A project lists its
observers in `telemetry.ts`:

```ts
// telemetry.ts
import { defineTelemetry } from '@arbol-ai/maximus';
import type { Observer } from '@arbol-ai/maximus';
import { analytics } from '@arbol-ai/maximus/analytics';

/** Writes each refused request to the dataset, by its failure code. */
const refusals: Observer<Env> = {
  admission(event, env) {
    env.EXECUTIONS.writeDataPoint({
      indexes: [event.service],
      blobs: ['refused', event.operation ?? '', event.surface, event.errorCode],
      doubles: [event.durationMicros],
    });
    return Promise.resolve();
  },
};

export default defineTelemetry({
  observers: [
    analytics({
      record: (env, event) => {
        env.EXECUTIONS.writeDataPoint({
          indexes: [event.organizationId],
          blobs: ['executed', event.operation, event.surface, event.outcome, event.errorCode ?? ''],
          doubles: [event.durationMicros],
        });
        return Promise.resolve();
      },
    }),
    refusals,
  ],
});
```

`EXECUTIONS` is a Workers Analytics Engine dataset, which `maximus()` declares as
`EXECUTIONS: bindings.analyticsEngineDataset({ name: 'executions' })`; see [Bindings](bindings.md).
`defineTelemetry` refuses any field but `enabled`, `observers` and `traceId`, and `telemetry.ts`, like the
other root modules, imports nothing that loads only in workerd. A Worker composed by hand passes the same
object as `maximus()`'s `telemetry` option.

An observer has up to three callbacks:

- `execution(event, env)` receives every operation call, over HTTP, MCP and RPC, success or failure:
  `service`, `operation`, `principal`, `surface` (`http`, `mcp` or `rpc`), `occurredAt`, `durationMicros`,
  `outcome` (`success` or `failure`), `errorCode` (`null` on success) and `traceId`.
- `admission(event, env)` receives every refusal that `maximus.admission.rejected` logs: `service`,
  `operation`, `principal`, `requestId`, `traceId`, `surface`, `occurredAt`, `durationMicros` and
  `errorCode`. `principal` is the verified caller when the refusal came after its token was verified, as a
  rate limit does, and `null` otherwise: an organization never comes from a token that was not verified.
- `error(error, surface, requestId)` is called with each unexpected error as it is thrown, before the call
  answers. It receives the error itself, message included: keep only its safe description,
  `createDiagnostics().describeError(error)`.

Observers run apart from the call and from one another:

- `execution` and `admission` run as background work, through the call's `waitUntil`, so the response never
  waits for them. A Worker always has one. A test that calls `handler(request, env)` without a third
  argument records no execution or refusal, and logs no `maximus.admission.rejected`; one that passes
  `{ waitUntil }` receives that work.
- A delivery that throws or rejects is logged as `maximus.observer.delivery_failed` with its request id. It
  never changes the response, and the other observers still receive the event. An `error` callback that
  throws is ignored.
- Background work is best effort: it can be lost when the runtime stops the invocation. An event that must
  never be lost belongs in a queue.
- An observer receives the verified principal, which names an actor and an organization. What the observer
  keeps, and for how long, is the observer's to decide.

### Durations and trace ids

`durationMicros` is wall-clock time in whole microseconds, not CPU time. A Worker's clock advances while it
waits on I/O, not while its code runs, so a duration measures the waits and is only as precise as the
runtime makes it.

`traceId` is `null` unless the telemetry's `traceId` returns the id of an actual trace, read from the
active span of the tracing the Worker runs. Maximus keeps it only when it is 32 lowercase hexadecimal
characters and not all zeros; any other value, or an accessor that throws, gives `null`. It is never read
from a request header and never generated: without a trace id, the request id correlates every record.

## Analytics

`analytics()`, from `@arbol-ai/maximus/analytics`, is an observer of operation calls. For each call it
builds one event of exactly these fields, and hands it to `record` to store, as the sample above does with
Workers Analytics Engine:

| Field            | Value                                                    |
| ---------------- | -------------------------------------------------------- |
| `id`             | A UUID of the event's own.                               |
| `service`        | The service's name.                                      |
| `operation`      | The operation's name.                                    |
| `organizationId` | The verified caller's organization.                      |
| `actorId`        | A pseudonym of the caller, or its id with `actor: 'id'`. |
| `actorKind`      | `user` or `service`.                                     |
| `requestId`      | The request id.                                          |
| `traceId`        | The trace id, or `null`.                                 |
| `surface`        | `http`, `mcp` or `rpc`.                                  |
| `occurredAt`     | When the call ended, in Unix milliseconds.               |
| `durationMicros` | How long it ran, in microseconds.                        |
| `outcome`        | `success` or `failure`.                                  |
| `errorCode`      | The failure's code, or `null`.                           |

`ExecutionEventSchema` is the event's strict schema and `ExecutionEvent` its type. No input, output,
credential or message reaches an event.

- **The actor is a pseudonym by default**: the hexadecimal SHA-256 of the organization id and the actor id.
  Distinct callers stay countable, and an identity provider that uses email addresses as subjects does not
  put them in your analytics. `actor: 'id'` records the actor id as the token states it.
- **`enabled`** turns analytics off on its own, for every call or per `env`, while telemetry stays on; it is
  on by default, and a function that throws turns recording off for that call. With telemetry off, no
  observer runs at all.
- **Delivery is checked.** An event that does not match `ExecutionEventSchema` is never recorded, and a
  `record` that answers `{ ok: false }` has not kept its event: either way the delivery fails and is logged
  as `maximus.observer.delivery_failed`. `.build()` and `defineErrors` refuse a service name, an operation
  name or a failure code an event could not carry, so a valid service never meets the first case.

The store you record into owns its access and its retention.

## Cloudflare's logs and traces

Cloudflare collects what the Worker writes and traces each invocation. `maximus()` turns that collection on
for the Worker with these settings:

| Setting               | Default | Effect                                                                   |
| --------------------- | ------- | ------------------------------------------------------------------------ |
| `enabled`             | `true`  | Workers Logs and traces for the Worker.                                  |
| `redactQueryString`   | `true`  | Query strings are removed from request URLs in logs and traces.          |
| `logs.enabled`        | `true`  | The Worker's console lines, Maximus's log events among them, are kept.   |
| `logs.invocationLogs` | `true`  | One log line per invocation, with its request's method and URL.          |
| `traces.enabled`      | `true`  | A trace of each invocation, with its fetches and binding calls as spans. |

A project sets its own with `observability` in `maximus()`'s options, under Cloudflare's names. They join
the defaults key by key, so a setting you leave out keeps its default, and `enabled: false` turns logs and
traces off unless you set theirs. For instance, to sample invocations and keep request paths out of the
logs:

```ts
// vite.config.ts
import { maximus } from '@arbol-ai/vite-plugin';
import { bindings } from 'cf/config';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [
    maximus({
      origin: 'https://notes.example.com',
      tokens: { issuer: 'https://auth.example.com/' },
      env: { NOTES: bindings.kv() },
      compatibilityDate: '2026-10-27',
      // One invocation in ten, and no invocation log lines; the other defaults stay.
      observability: { headSamplingRate: 0.1, logs: { invocationLogs: false } },
    }),
  ],
});
```

[Configuration](../reference/configuration.md) lists the options. A path that can carry an identifier you
must not log, such as a person's record number, is a reason to turn invocation logs off.

What you find there:

- **Logs**: search for `maximus.unexpected` and its `requestId` to find a failure. Its `locations` are
  lines and columns of the deployed bundle, which the build minifies; `vp build` writes a source map beside
  the bundle, in `.cloudflare/output/`, that maps them to your sources.
- **Traces**: each operation call's span carries `service.name`, `operation.name` and `request.id`, so a
  trace and the log lines of its request share an id. Maximus sets them as the operation starts to run, so
  the span of a refused request carries none of them.
- **Exports**: `logs.destinations` and `traces.destinations` send logs and traces on to destinations you
  configure in your Cloudflare account. An export carries the invocation logs and span attributes as
  Cloudflare records them, which Maximus does not filter: review what they contain before you add one.

Maximus's switch and Cloudflare's collection are separate controls. `telemetry.enabled` stops Maximus's own
events and observers, at runtime; `observability` decides what Cloudflare collects, and changes with a
deployment. Turning one off leaves the other as it is.
