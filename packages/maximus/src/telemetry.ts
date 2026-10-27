/**
 * Telemetry: invocation-local diagnostics kept in AsyncLocalStorage, safe native log events, and observers
 * that receive execution and admission observations as background work.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import type { Failure } from './errors.ts';
import { createDiagnostics } from './internal/diagnostics.ts';
import type { Result } from './result.ts';
import type { Principal } from './tokens.ts';

/** Where background work goes: the runtime's `waitUntil`, such as a Worker's ExecutionContext. */
export interface BackgroundContext {
  /**
   * Keeps `promise` running after the response, as a Worker's `ctx.waitUntil` does. Best effort: never
   * durable.
   */
  waitUntil: (promise: Promise<unknown>) => void;
}
/**
 * What observers learn about one operation call: the service, operation, principal and surface, when and for
 * how long, the outcome and its failure code, and the active trace id. Never input, output or credentials.
 */
export interface ExecutionObservation {
  /** The application's `name`, its service identifier. */
  service: string;
  /** The operation's name, its key among the application's operations. */
  operation: string;
  /** The caller the operation ran as: its actor, actor kind, organization and request id. */
  principal: Principal;
  /**
   * Where the call arrived: `http` at an operation route, `mcp` through a transport (MCP tool calls), `rpc`
   * over Worker RPC.
   */
  surface: 'http' | 'mcp' | 'rpc';
  /** When the call was recorded, just after it finished, in Unix milliseconds. */
  occurredAt: number;
  /** Wall-clock time the operation's execution took, in whole microseconds; not CPU time. */
  durationMicros: number;
  /** `success` when the operation answered its output, `failure` when it answered a failure. */
  outcome: 'success' | 'failure';
  /** The failure's code, such as `INVALID_INPUT`, when `outcome` is `failure`; null on success. */
  errorCode: string | null;
  /**
   * The active exporter trace id that `telemetry.traceId` returned, 32 lowercase hexadecimal characters; null
   * when it returned none or an invalid one.
   */
  traceId: string | null;
}
/**
 * What observers learn about a request refused before any operation ran: the operation and principal when
 * known, the surface, its timing and the failure code.
 */
export interface AdmissionObservation {
  /** The application's `name`, its service identifier. */
  service: string;
  /**
   * The name of the operation the refusal concerns; null when there is none, such as for an unknown path or a
   * whole transport request.
   */
  operation: string | null;
  /**
   * The verified caller when the refusal came after token verification, such as a rate limit; null otherwise.
   */
  principal: Principal | null;
  /** The refused request's id, echoed in its `x-request-id` header. */
  requestId: string;
  /**
   * The active exporter trace id that `telemetry.traceId` returned, 32 lowercase hexadecimal characters; null
   * when it returned none or an invalid one.
   */
  traceId: string | null;
  /** Where the request arrived: `mcp` at a transport's path, such as `/mcp`, else `http`. */
  surface: 'http' | 'mcp';
  /** When the refusal was recorded, in Unix milliseconds. */
  occurredAt: number;
  /** Wall-clock time from the start of admission to the refusal, in whole microseconds. */
  durationMicros: number;
  /** The refusal's failure code, such as `UNAUTHORIZED`, `NOT_FOUND` or `RATE_LIMITED`. */
  errorCode: string;
}
/**
 * Receives observations as background work: operation calls, refused admissions and unexpected errors. An
 * observer that fails affects neither the response nor another observer.
 */
export interface Observer<E> {
  /**
   * Receives the observation of every operation call, success or failure, on every surface, with that call's
   * env.
   */
  execution?: (event: ExecutionObservation, env: E) => Promise<unknown>;
  /**
   * Receives the observation of each refusal before execution, such as a bad token or a rate limit, with the
   * request's env.
   */
  admission?: (event: AdmissionObservation, env: E) => Promise<unknown>;
  /**
   * Called synchronously with each unexpected error as thrown, its surface (such as `http` or `operation`)
   * and the request id when known; record only a safe description.
   */
  error?: (error: unknown, surface: string, requestId?: string) => void;
}
/**
 * Whether diagnostics and observers run (for each env, when a function), the observers, and how to read the
 * active trace id.
 */
export interface TelemetryConfig<E> {
  /**
   * Whether Maximus writes its log events, calls observers and annotates spans, or a function that decides
   * per env; on by default.
   */
  enabled?: boolean | ((env: E) => boolean);
  /**
   * The observers that receive execution and admission observations and unexpected errors, each isolated from
   * the others.
   */
  observers?: readonly Observer<E>[];
  /** Read an actual active exporter trace, never a client-supplied header or generated correlation ID. */
  traceId?: () => string | null;
}
/** Microseconds since `started`, a `performance.now()` reading. */
function elapsedMicros(started: number): number {
  return Math.max(0, Math.round((performance.now() - started) * 1000));
}

/**
 * Hands one event to one observer as background work: a failed delivery is logged with its request id
 * and never reaches the response or another observer.
 */
function deliver(background: BackgroundContext, requestId: string, send: () => unknown): void {
  background.waitUntil(
    Promise.resolve()
      .then(send)
      .catch(() => {
        console.error(JSON.stringify({ event: 'maximus.observer.delivery_failed', requestId }));
      })
  );
}

/**
 * The active trace id the configuration reads, when it is a valid non-zero W3C trace id; never a generated
 * one.
 */
function activeTraceId<E>(config?: TelemetryConfig<E>): string | null {
  try {
    const id = config?.traceId?.();
    return id && /^[0-9a-f]{32}$/.test(id) && !/^0+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
/** Logs a refused admission (`maximus.admission.rejected`) and hands it to the observers. */
export function recordAdmission<E>(
  manifest: { name: string; telemetry?: TelemetryConfig<E> },
  env: E,
  background: BackgroundContext | undefined,
  admission: Omit<AdmissionObservation, 'service' | 'traceId' | 'occurredAt' | 'durationMicros'> & {
    started: number;
  }
): void {
  if (!background || !telemetryEnabled(manifest.telemetry, env)) {
    return;
  }
  const event: AdmissionObservation = {
    service: manifest.name,
    operation: admission.operation,
    principal: admission.principal,
    requestId: admission.requestId,
    traceId: activeTraceId(manifest.telemetry),
    surface: admission.surface,
    occurredAt: Date.now(),
    durationMicros: elapsedMicros(admission.started),
    errorCode: admission.errorCode,
  };
  // Native logs cover rejected requests even when no shared analytics sink is installed.
  // Native logs contain technical correlation only; verified identity remains available to owner observers.
  // The operation is resolved from the manifest; raw paths, headers and bodies never enter this event.
  try {
    console.warn(
      JSON.stringify({
        event: 'maximus.admission.rejected',
        service: event.service,
        operation: event.operation,
        requestId: event.requestId,
        traceId: event.traceId,
        surface: event.surface,
        occurredAt: event.occurredAt,
        durationMicros: event.durationMicros,
        errorCode: event.errorCode,
      })
    );
  } catch {
    /* Native diagnostics are best effort. */
  }
  for (const observer of manifest.telemetry?.observers ?? []) {
    if (observer.admission) {
      deliver(background, event.requestId, () => observer.admission?.(event, env));
    }
  }
}
/**
 * Whether telemetry is on for this env: it is unless `enabled` is false, or a function that returns false,
 * has no env to read or throws.
 */
export function telemetryEnabled<E>(
  config: Pick<TelemetryConfig<E>, 'enabled'> | undefined,
  env: E | undefined
): boolean {
  if (typeof config?.enabled !== 'function') {
    return config?.enabled !== false;
  }
  if (env === undefined) {
    return false;
  }
  try {
    return config.enabled(env);
  } catch {
    // A switch that fails, such as one that reads a binding the env lacks, turns telemetry off rather than
    // failing the request; the log says so, without the failure's text.
    try {
      console.error(JSON.stringify({ event: 'maximus.telemetry.switch_failed' }));
    } catch {
      /* Diagnostics are best effort. */
    }
    return false;
  }
}
/** Describes errors by their built-in names only. */
const diagnostics = createDiagnostics();
/** What one invocation's diagnostics carry: whether they are on, and its observers. */
type DiagnosticsStore = {
  /** Whether diagnostics are on for this invocation; when off, `reportUnexpected` neither logs nor tells observers. */
  enabled: boolean;
  /** The observers `reportUnexpected` tells of this invocation's unexpected errors. */
  observers: readonly Observer<never>[];
};
// Created on first use, not at import: a browser bundle that imports a contract
// (which imports this package for its schemas) never constructs it.
let storage: AsyncLocalStorage<DiagnosticsStore> | undefined;
/** The invocation-local store, created on first use. */
function current(): AsyncLocalStorage<DiagnosticsStore> {
  storage ??= new AsyncLocalStorage<DiagnosticsStore>();
  return storage;
}
/**
 * Runs `callback` and everything it calls, synchronously or not, with diagnostics on or off and these
 * observers.
 */
// AsyncLocalStorage.run preserves the callback's return type and asynchronous isolation.
// oxlint-disable-next-line promise/prefer-await-to-callbacks
export function withDiagnostics<T>(
  enabled: boolean,
  callback: () => T,
  observers: readonly Observer<never>[] = []
): T {
  return current().run({ enabled, observers }, callback);
}
/** Runs `work` with the diagnostics an application's telemetry turns on for this `env`. */
export function withTelemetry<E, T>(
  config: TelemetryConfig<E> | undefined,
  env: E | undefined,
  work: () => T
): T {
  return withDiagnostics(telemetryEnabled(config, env), work, config?.observers);
}
/** Whether the current call runs with diagnostics on; they are on outside any `withDiagnostics`. */
export function diagnosticsEnabled(): boolean {
  return storage?.getStore()?.enabled !== false;
}
/**
 * Logs an unexpected error by its safe description only (`maximus.unexpected`: error and cause names, issue
 * count, stack locations; never a message) and tells the observers.
 */
export function reportUnexpected(error: unknown, surface = 'application', requestId?: string): void {
  if (!diagnosticsEnabled()) {
    return;
  }
  try {
    console.error(
      JSON.stringify({ event: 'maximus.unexpected', surface, requestId, ...diagnostics.describeError(error) })
    );
  } catch {
    /* Diagnostics are best effort. */
  }
  for (const observer of storage?.getStore()?.observers ?? []) {
    try {
      observer.error?.(error, surface, requestId);
    } catch {
      /* Independent exporters cannot break one another. */
    }
  }
}
/** Hands the observation of one operation call to the observers, as background work. */
export function recordExecution<E>(
  manifest: { name: string; telemetry?: TelemetryConfig<E> },
  env: E,
  background: BackgroundContext | undefined,
  invocation: {
    principal: Principal;
    operation: string;
    surface: ExecutionObservation['surface'];
    started: number;
    result: Result<unknown, Failure>;
  }
): void {
  if (!background || !telemetryEnabled(manifest.telemetry, env)) {
    return;
  }
  const event: ExecutionObservation = {
    service: manifest.name,
    operation: invocation.operation,
    principal: invocation.principal,
    surface: invocation.surface,
    occurredAt: Date.now(),
    durationMicros: elapsedMicros(invocation.started),
    outcome: invocation.result.ok ? 'success' : 'failure',
    errorCode: invocation.result.ok ? null : invocation.result.error.code,
    traceId: activeTraceId(manifest.telemetry),
  };
  for (const observer of manifest.telemetry?.observers ?? []) {
    if (observer.execution) {
      deliver(background, event.principal.requestId, () => observer.execution?.(event, env));
    }
  }
}
