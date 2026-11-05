/**
 * Capture's hook in the core: what an application declares and the recording point beside `recordExecution`
 * and `recordAdmission`. Every record is built and sent as background work, isolated from the response and
 * from the observers, so it always states what the caller received and never changes it. The `capture` entry
 * holds the declaration helper and the sinks; this module knows neither.
 */
import type { Attachment } from './attachment-schema.ts';
import { isAttachmentSchema } from './binary.ts';
import type { CaptureRecord } from './capture-record.ts';
import type { ErrorCatalog, Failure } from './errors.ts';
import type { ExecutionCall } from './execution.ts';
import { delay } from './internal/delay.ts';
import { sha256Hex } from './internal/digest.ts';
import { operationScopes } from './manifest.ts';
import type { InvocationAuthority, OperationShape } from './manifest.ts';
import type { Result } from './result.ts';
import { holdsSecrets, withoutSecrets } from './secrets.ts';
import { activeTraceId, elapsedMicros } from './telemetry.ts';
import type { BackgroundContext, TelemetryConfig } from './telemetry.ts';
import type { Principal, TokenClient } from './tokens.ts';

/** The most entries a `dimensions` callback's answer keeps, and the longest value of each. */
const MAX_DIMENSIONS = 32;
const MAX_DIMENSION_LENGTH = 256;

/** What a context is read as unless `defineCapture` names its type. */
// oxlint-disable-next-line typescript/no-explicit-any -- a service reads its own context's fields by name.
export type AnyContext = Record<string, any>;

/**
 * What a `dimensions` callback learns of a call. It belongs to that call: read what it already knows, and start
 * nothing.
 */
export interface CaptureInvocation<E, C = AnyContext> {
  /** The Worker's bindings. */
  readonly env: E;
  /** The operation's name; null when a refusal names none. */
  readonly operation: string | null;
  /** The transport that admitted the call. */
  readonly surface: CaptureRecord['surface'];
  /** The verified caller; null when the refusal came before it was verified. */
  readonly principal: Principal | null;
  /** What admission verified about the token, without the token. Absent as `Invocation.authority` is. */
  readonly authority?: Omit<InvocationAuthority, 'token'>;
  /** Over RPC, the caller admission checked. */
  readonly rpcCaller?: string;
  /** On HTTP and MCP, the request's user agent. What the caller claims. */
  readonly userAgent?: string;
  /** What the handler received, when the call got that far; empty before its context was prepared. */
  readonly context: Partial<C>;
  /** The decoded input, secrets included, for the callback to read ids from; absent for a refused input. */
  readonly input?: unknown;
}
/**
 * What a call is about, in the service's own words: `{ agentId, conversationId }`. Each value is an identifier
 * of up to 256 characters that the record may carry; any other value is left out.
 */
export type CaptureDimensions = Readonly<Record<string, string | null | undefined>>;
/** Where records go. */
export interface CaptureSink<E> {
  /**
   * Keeps one record; a rejection is a failed delivery. Capture itself never retries: a sink retries what it
   * can safely repeat, as `pipeline` does, and one that cannot, an append whose outcome may be lost, does not.
   */
  send: (record: CaptureRecord, env: E) => Promise<unknown>;
  /**
   * Whether this env can take records at all, such as a binding that exists in production and not in a preview.
   * When it answers false, the call builds no record and logs nothing. Always when omitted.
   */
  available?: (env: E) => boolean;
}
/** What a project's `capture.ts` declares, and what `maximus()` takes as `capture`. */
export interface CaptureConfig<E = unknown, C = AnyContext> {
  /**
   * Whether calls are captured: a boolean, or a function that decides for each env; on by default. It is apart
   * from `telemetry.enabled`. A function that throws turns capture off for that call and logs
   * `maximus.capture.switch_failed`.
   */
  enabled?: boolean | ((env: E) => boolean);
  /** Where records go. */
  sink: CaptureSink<E>;
  /**
   * `all` also records each decoded input, checked output and failure data, without what their schemas mark
   * `secret: true`; `none`, the default, records the metadata alone.
   */
  payloads?: 'all' | 'none';
  /**
   * What the call is about, as `record.dimensions`. It runs as background work, and one that throws leaves the
   * record without dimensions and logs `maximus.capture.dimensions_failed`.
   */
  dimensions?: (invocation: CaptureInvocation<E, C>) => CaptureDimensions;
}
/** What a recording point reads of the application. */
interface CaptureApplication<E> {
  name: string;
  version: string;
  operations: Readonly<Record<string, OperationShape>>;
  errors: ErrorCatalog;
  capture?: CaptureConfig<E>;
  telemetry?: TelemetryConfig<E>;
}
/** What admission verified about a token, once it has. */
export interface VerifiedCaller {
  /** The scopes the token grants. */
  readonly scopes: readonly string[];
  /** The OAuth client it was issued to, when it names one. */
  readonly client?: TokenClient;
  /** The token as presented, which only its digest leaves this module as. */
  readonly token?: string;
}
/** One call, or one refusal, as a transport hands it to `recordCapture`. */
export interface CapturedCall {
  /** The operation's name; null when a refusal names none. */
  operation: string | null;
  /** The transport that admitted the call. */
  surface: CaptureRecord['surface'];
  /** The request's id. */
  requestId: string;
  /** The verified caller; null before it was verified. */
  principal: Principal | null;
  /** What admission verified about the token; absent before it did, and over RPC. */
  verified?: VerifiedCaller;
  /** A `performance.now()` reading when the transport began admitting the call. */
  requestStarted: number;
  /** A `performance.now()` reading when execution began; absent for a refusal before it. */
  executionStarted?: number;
  /** What the caller received. */
  result: Result<unknown, Failure>;
  /** What the transport knows of the call beyond this, and what execution left for the record. */
  call?: ExecutionCall;
}

/** Writes one line of capture's own diagnostics; they are best effort. */
function logCapture(line: { event: string; requestId?: string }): void {
  try {
    console.error(JSON.stringify(line));
  } catch {
    /* Diagnostics are best effort. */
  }
}

/** Whether capture is on for this env: a switch that throws turns it off and says so. */
function captureEnabled<E>(capture: CaptureConfig<E>, env: E): boolean {
  if (typeof capture.enabled !== 'function') {
    return capture.enabled !== false;
  }
  try {
    return capture.enabled(env);
  } catch {
    logCapture({ event: 'maximus.capture.switch_failed' });
    return false;
  }
}

/** A UUIDv7 at this instant: its leading bits are the time, so ids sort by when their records happened. */
function timeOrderedId(instant: number): string {
  const time = instant.toString(16).padStart(12, '0');
  const random = crypto.randomUUID().replaceAll('-', '');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(13, 16)}-${random.slice(16, 20)}-${random.slice(20)}`;
}

/**
 * The input a record carries. An input whose schema marks nothing is the decoded one, as plain JSON. One whose
 * schema marks a field is what the schema checked, without that field: a codec may move a value to where no
 * mark reaches, so only the checked value is known to have the shape the marks describe. Decoded values a
 * record cannot carry, such as a `BigInt`, fall back to the checked one, which is plain JSON by admission.
 */
function recordedInput(schema: OperationShape['input'], admitted: ExecutionCall['admitted']): unknown {
  if (!admitted) {
    return null;
  }
  if (holdsSecrets(schema)) {
    return withoutSecrets(schema, admitted.checked) ?? null;
  }
  if (admitted.decoded === admitted.checked) {
    return admitted.checked;
  }
  try {
    // Decoded values may be class instances: the record states what JSON makes of them.
    // oxlint-disable-next-line unicorn/prefer-structured-clone
    return JSON.parse(JSON.stringify(admitted.decoded));
  } catch {
    return admitted.checked;
  }
}

/** The output a record carries: never an attachment's bytes, and never what its schema marks. */
function recordedOutput(schema: OperationShape['output'], value: unknown): unknown {
  if (isAttachmentSchema(schema)) {
    const { contentType, filename, byteLength } = value as Attachment;
    return { contentType, filename, byteLength };
  }
  return holdsSecrets(schema) ? (withoutSecrets(schema, value) ?? null) : value;
}

/** The failure's data a record carries, without what its code's schema marks. */
function recordedFailureData(errors: ErrorCatalog, failure: Failure): unknown {
  const schema = Object.values(errors.definitions).find(({ code }) => code === failure.code)?.dataSchema;
  return schema && holdsSecrets(schema)
    ? (withoutSecrets(schema, failure.data) ?? null)
    : (failure.data ?? null);
}

/** What the `dimensions` callback names for this call: bounded identifiers, or nothing when it throws. */
function recordedDimensions<E>(
  application: CaptureApplication<E>,
  env: E,
  captured: CapturedCall
): Record<string, string> {
  const dimensions = application.capture?.dimensions;
  if (!dimensions) {
    return {};
  }
  try {
    const { operation, surface, principal, verified, call } = captured;
    const named = dimensions({
      env,
      operation,
      surface,
      principal,
      ...(verified?.client
        ? {
            authority: {
              surface: surface as 'http' | 'mcp',
              scopes: verified.scopes,
              client: verified.client,
            },
          }
        : {}),
      ...(call?.rpcCaller ? { rpcCaller: call.rpcCaller } : {}),
      ...(call?.userAgent ? { userAgent: call.userAgent } : {}),
      context: (call?.context ?? {}) as AnyContext,
      ...(call?.admitted ? { input: call.admitted.decoded } : {}),
    });
    return Object.fromEntries(
      Object.entries(named)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '')
        .slice(0, MAX_DIMENSIONS)
        .map(([name, value]) => [name, value.slice(0, MAX_DIMENSION_LENGTH)])
    );
  } catch {
    logCapture({ event: 'maximus.capture.dimensions_failed', requestId: captured.requestId });
    return {};
  }
}

/** What is read of the clock and the active trace as a call answers, on the transport's own turn. */
interface CallMoment {
  occurredAt: number;
  startedAt: number;
  durationMicros: number;
  admissionMicros: number;
  traceId: string | null;
}

/** The record of one call, as background work. */
async function buildRecord<E>(
  application: CaptureApplication<E>,
  capture: CaptureConfig<E>,
  env: E,
  captured: CapturedCall,
  moment: CallMoment
): Promise<CaptureRecord> {
  const { operation, surface, principal, verified, result, call } = captured;
  const declared =
    operation !== null && Object.hasOwn(application.operations, operation)
      ? application.operations[operation]
      : undefined;
  const http = surface === 'http' ? declared?.http : undefined;
  const payloads = capture.payloads === 'all';
  return {
    id: timeOrderedId(moment.occurredAt),
    service: application.name,
    operation,
    organizationId: principal?.organizationId ?? null,
    actorId: principal?.actorId ?? null,
    actorKind: principal?.actorKind ?? null,
    requestId: captured.requestId,
    traceId: moment.traceId,
    surface,
    occurredAt: moment.occurredAt,
    durationMicros: moment.durationMicros,
    outcome: result.ok ? 'success' : 'failure',
    errorCode: result.ok ? null : result.error.code,
    stage: captured.executionStarted === undefined ? 'admission' : 'execution',
    version: application.version,
    effect: declared?.effect ?? null,
    scopes: declared ? [...operationScopes(declared)] : [],
    visibility: declared ? (declared.visibility ?? 'public') : null,
    httpMethod: http?.method ?? null,
    httpPath: http?.path ?? null,
    mcpTool: surface === 'mcp' ? (declared?.mcp?.name ?? null) : null,
    rpcCaller: call?.rpcCaller ?? null,
    clientId: verified?.client?.id ?? null,
    clientClass: verified?.client?.class ?? null,
    grantedScopes: verified ? [...verified.scopes] : null,
    userAgent: call?.userAgent ?? null,
    tokenSha256: verified?.token ? await sha256Hex(verified.token) : null,
    dimensions: recordedDimensions(application, env, captured),
    startedAt: moment.startedAt,
    admissionMicros: moment.admissionMicros,
    input: payloads && declared ? recordedInput(declared.input, call?.admitted) : null,
    output: payloads && declared && result.ok ? recordedOutput(declared.output, result.value) : null,
    failureData: payloads && !result.ok ? recordedFailureData(application.errors, result.error) : null,
    payloadRef: null,
  };
}

/**
 * Captures one call beside `recordExecution` or `recordAdmission`, as background work: it never throws, never
 * delays or changes the response and never affects an observer. A failed delivery logs
 * `maximus.capture.delivery_failed` with the request id alone. Nothing is recorded without a background context,
 * or while capture is off, whether telemetry is on or not.
 */
export function recordCapture<E>(
  application: CaptureApplication<E>,
  env: E,
  background: BackgroundContext | undefined,
  captured: CapturedCall
): void {
  const { capture } = application;
  if (!(capture && background)) {
    return;
  }
  try {
    if (!captureEnabled(capture, env) || capture.sink.available?.(env) === false) {
      return;
    }
    const occurredAt = Date.now();
    const admissionMicros = elapsedMicros(captured.requestStarted, captured.executionStarted);
    const executionMicros =
      captured.executionStarted === undefined ? 0 : elapsedMicros(captured.executionStarted);
    const moment: CallMoment = {
      occurredAt,
      startedAt: Math.max(0, Math.round(occurredAt - (admissionMicros + executionMicros) / 1000)),
      durationMicros: captured.executionStarted === undefined ? admissionMicros : executionMicros,
      admissionMicros,
      traceId: activeTraceId(application.telemetry),
    };
    background.waitUntil(
      // A timer, not a microtask: a microtask would run before the response is built, and this one holds the
      // encoding of a whole input and output.
      delay(0)
        .then(() => buildRecord(application, capture, env, captured, moment))
        .then((record) => capture.sink.send(record, env))
        .catch(() => {
          logCapture({ event: 'maximus.capture.delivery_failed', requestId: captured.requestId });
        })
    );
  } catch {
    logCapture({ event: 'maximus.capture.delivery_failed', requestId: captured.requestId });
  }
}
