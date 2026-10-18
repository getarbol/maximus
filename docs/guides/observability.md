# Observability

Maximus records enough to correlate and diagnose every call without recording what callers sent.
Telemetry is Cloudflare's own: Workers Logs and Workers traces. This guide covers the request id,
the native log events, the telemetry switch, observers, the analytics observer, and the Cloudflare
configuration that collects them.

## Privacy first

No request or response body, header, URL query, credential, cookie, error message or stack text
enters anything Maximus records or sends. Diagnostics carry developer constants (service and
operation names, error codes, error class names) and technical correlation (request ids, durations,
source locations). Your own `console.log` calls are yours to keep equally clean.

## Correlation

Every request gets a fresh UUID. It is the `x-request-id` response header, `metadata.requestId` in
the envelope, `principal.requestId` in your handler, and `requestId` in every event below. Incoming
`x-request-id` and trace headers are never adopted. Native RPC calls carry the caller's principal, so
its `requestId` continues across Workers.

When the runtime exposes an active span, Maximus sets `service.name`, `operation.name` and
`request.id` on it. To find a request in Cloudflare's traces, search for `request.id`.

## Native log events

Maximus writes one-line JSON to the Workers console, which Cloudflare's logs collect:

| Event | Level | When | Fields |
| --- | --- | --- | --- |
| `maximus.admission.rejected` | warn | A request was refused before execution: unknown route, bad token, missing scope, rate limit, oversized or malformed body. | `service`, `operation` (or `null`), `requestId`, `traceId`, `surface`, `occurredAt`, `durationMicros`, `errorCode` |
| `maximus.unexpected` | error | A handler threw, returned an invalid output, or a framework step failed unexpectedly. | `surface`, `requestId`, `name`, `causes`, `issueCount`, `locations` |
| `maximus.observer.delivery_failed` | error | An observer's promise rejected. | `requestId` |

`maximus.admission.rejected` never names the actor or the organization, even when the token was
valid; the `admission` observer below receives the verified principal instead. `maximus.unexpected`
names only built-in error classes (`TypeError`, `RangeError`, …); any other name becomes
`UnknownError`. `locations` are line and column numbers for source maps.

`reportUnexpected(error, surface, requestId)` writes the same event for an error you caught yourself.

## The telemetry switch

```ts
maximus<Env>({
  // ...
  telemetry: { enabled: (env) => env.TELEMETRY_ENABLED !== 'false' },
});
```

`telemetry.enabled` is a boolean or a function of the environment, `true` by default. Disabling it
turns off every Maximus output: log events, observers and span annotations.

It does not turn off Cloudflare's own collection. Workers logs and traces are configured in
`cloudflare.config.ts` (`observability.enabled`, sampling and export destinations); a runtime flag
cannot rewrite that file. To stop platform capture as well, change the configuration and redeploy.

## Observers

An observer receives events after the response, through the invocation's `waitUntil`:

```ts
import type { Observer } from '@arbol-ai/maximus';

const metrics: Observer<Env> = {
  async execution(event, env) {
    // event: service, operation, principal, surface, occurredAt, durationMicros, outcome, errorCode, traceId
  },
  async admission(event, env) {
    // event: service, operation, principal (verified, or null), requestId, traceId, surface,
    // occurredAt, durationMicros, errorCode
  },
  error(error, surface, requestId) {
    // called synchronously for each unexpected error
  },
};

maximus<Env>({ /* ... */ telemetry: { observers: [metrics] } });
```

- `execution` fires once for every executed operation, on every transport (`surface` is `http`,
  `mcp` or `rpc`), success or failure.
- `admission` fires once for every request refused before execution. Its `principal` is set only if
  the token was verified; an organization is never recovered from an unverified token.
- Observers are isolated: a rejected promise or a thrown `error` callback is contained, logged as
  `maximus.observer.delivery_failed` when it is a promise, and never changes the response or another
  observer.
- An observer owns the privacy of what it stores. It receives a verified principal; decide whether
  your sink may keep it.

`waitUntil` work is bounded best effort after the response. It is not a durable queue or a ledger;
when losing an event is unacceptable, send it to a Queue.

### Durations and trace ids

`durationMicros` is wall-clock time in microseconds, not CPU time and not a promise of microsecond
precision: Workers timers do not advance during synchronous execution.

`traceId` is `null` unless you provide `telemetry.traceId: () => string | null`, which must return
the 32-hex id of a real active exporter span. Invalid, all-zero and throwing accessors produce
`null`. Workers' native span API exposes no id today, so correlate by `request.id`; never generate an
unrelated id to fill the field.

## Analytics

`@arbol-ai/maximus/analytics` turns execution observations into an allowlisted record for your sink:

```ts
import { analytics } from '@arbol-ai/maximus/analytics';

maximus<Env>({
  // ...
  telemetry: {
    observers: [
      analytics<Env>({
        enabled: (env) => env.ANALYTICS_ENABLED !== 'false',
        record: async (env, event) => {
          env.EXECUTIONS.writeDataPoint({
            indexes: [event.organizationId],
            blobs: [event.service, event.operation, event.surface, event.outcome, event.errorCode ?? ''],
            doubles: [event.durationMicros],
          });
        },
      }),
    ],
  },
});
```

The event (`ExecutionEvent`, with `ExecutionEventSchema` to validate it) holds exactly: `id`,
`service`, `operation`, `organizationId`, `actorId`, `actorKind`, `requestId`, `traceId`, `surface`,
`occurredAt`, `durationMicros`, `outcome` and `errorCode`. A `record` that answers `{ ok: false }` is
a delivery failure. Your sink owns storage, access and retention.

## Cloudflare logs and traces

Maximus sends nothing to a third party. Cloudflare collects what it writes, configured in each
Worker's `cloudflare.config.ts`:

```ts
observability: {
  enabled: true,
  logs: { enabled: true, invocationLogs: true },
  traces: { enabled: true },
},
```

- **Logs**: the events above, your own `console` lines, and one invocation log per request. Find an
  error by `maximus.unexpected` and its `requestId`; its `locations` are positions in the deployed
  bundle, which its source map resolves.
- **Traces**: Cloudflare traces each invocation and its outgoing fetches and binding calls. Maximus
  adds `service.name`, `operation.name` and `request.id` to the active span, so a trace and its log
  lines share the request id.
- **Sampling**: `head_sampling_rate` under `logs` or `traces`, in the same block.

Cloudflare can also export logs and traces to an OTLP destination. An export carries invocation logs
and span attributes that Maximus does not filter; review what it contains before adding one.

Receiving an event is not an alert. Configure alerting on the logs you keep, and test it.
