/**
 * Execution and admission observations: what observers and the native log receive, the trace id they carry,
 * and how a switched-off env, a missing background context or a failing observer is contained.
 */
import { afterEach, expect, it, vi } from 'vite-plus/test';

import type { Failure, Result } from '../../src/index.ts';
import { recordAdmission, recordExecution } from '../../src/telemetry.ts';
import type {
  AdmissionObservation,
  BackgroundContext,
  ExecutionObservation,
  TelemetryConfig,
} from '../../src/telemetry.ts';

/** The binding the telemetry switch reads. */
interface Env {
  TELEMETRY: 'on' | 'off';
}

const on: Env = { TELEMETRY: 'on' };
const off: Env = { TELEMETRY: 'off' };
const principal = {
  actorId: 'person-1',
  actorKind: 'user' as const,
  organizationId: 'org_1234567890abcdef',
  requestId: '00000000-0000-4000-8000-000000000001',
};
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A background context that keeps the work handed to it. */
function background(): { tasks: Promise<unknown>[]; context: BackgroundContext } {
  const tasks: Promise<unknown>[] = [];
  return {
    tasks,
    context: {
      waitUntil: (task) => {
        tasks.push(task);
      },
    },
  };
}

/** Records one RPC call of `readRecord` under these telemetry settings. */
function execute(
  telemetry: TelemetryConfig<Env> | undefined,
  env: Env,
  context: BackgroundContext | undefined,
  result: Result<unknown, Failure> = { ok: true, value: { recordId: 'rec_PRIVATE' } }
): void {
  recordExecution({ name: 'records', telemetry }, env, context, {
    principal,
    operation: 'readRecord',
    surface: 'rpc',
    started: performance.now(),
    result,
  });
}

/** Records one refused HTTP admission of `readRecord` under these telemetry settings. */
function refuse(
  telemetry: TelemetryConfig<Env> | undefined,
  env: Env,
  context: BackgroundContext | undefined
): void {
  recordAdmission({ name: 'records', telemetry }, env, context, {
    principal,
    operation: 'readRecord',
    surface: 'http',
    requestId: principal.requestId,
    started: performance.now(),
    errorCode: 'RATE_LIMITED',
  });
}

it('observes a failed call by its failure code alone, never by its message or data', async () => {
  const execution = vi.fn(async (_event: ExecutionObservation, _env: Env) => undefined);
  const { tasks, context } = background();
  execute({ observers: [{ execution }] }, on, context, {
    ok: false,
    error: {
      code: 'NOT_FOUND',
      message: 'Record rec_PRIVATE was not found.',
      retryable: false,
      data: { recordId: 'rec_PRIVATE' },
    },
  });
  await Promise.all(tasks);
  expect(execution).toHaveBeenCalledExactlyOnceWith(
    {
      service: 'records',
      operation: 'readRecord',
      principal,
      surface: 'rpc',
      occurredAt: expect.any(Number),
      durationMicros: expect.any(Number),
      outcome: 'failure',
      errorCode: 'NOT_FOUND',
      traceId: null,
    },
    on
  );
  const durationMicros = execution.mock.calls[0]?.[0].durationMicros;
  expect(Number.isInteger(durationMicros) && Number(durationMicros) >= 0).toBe(true);
  expect(JSON.stringify(execution.mock.calls)).not.toContain('PRIVATE');
});

it('carries a trace id only when the configured reader answers a valid non-zero W3C trace id', async () => {
  const readers: [() => string | null, string | null][] = [
    [() => TRACE_ID, TRACE_ID],
    [() => TRACE_ID.toUpperCase(), null],
    [() => '0'.repeat(32), null],
    [() => `${TRACE_ID}0`, null],
    [() => principal.requestId, null],
    [() => null, null],
    [
      () => {
        throw new Error('exporter unavailable');
      },
      null,
    ],
  ];
  for (const [traceId, expected] of readers) {
    const execution = vi.fn(async (_event: ExecutionObservation, _env: Env) => undefined);
    const { tasks, context } = background();
    execute({ observers: [{ execution }], traceId }, on, context);
    await Promise.all(tasks);
    expect(execution.mock.calls[0]?.[0].traceId).toBe(expected);
  }
});

it('skips observers without an execution callback, and records nothing unless telemetry and a context allow it', async () => {
  const execution = vi.fn(async () => undefined);
  const admission = vi.fn(async () => undefined);
  const telemetry: TelemetryConfig<Env> = {
    enabled: (env) => env.TELEMETRY === 'on',
    observers: [{ admission }, { execution }],
  };
  const { tasks, context } = background();
  execute(telemetry, on, context);
  execute(telemetry, off, context);
  execute(telemetry, on, undefined);
  execute(undefined, on, context);
  await Promise.all(tasks);
  expect(tasks).toHaveLength(1);
  expect(execution).toHaveBeenCalledOnce();
  expect(admission).not.toHaveBeenCalled();
});

it('logs a refused admission with technical correlation alone and hands the verified principal to observers', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const admission = vi.fn(async (_event: AdmissionObservation, _env: Env) => undefined);
  const { tasks, context } = background();
  refuse({ observers: [{ admission }], traceId: () => TRACE_ID }, on, context);
  expect(warn).toHaveBeenCalledOnce();
  expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
    event: 'maximus.admission.rejected',
    service: 'records',
    operation: 'readRecord',
    requestId: principal.requestId,
    traceId: TRACE_ID,
    surface: 'http',
    occurredAt: expect.any(Number),
    durationMicros: expect.any(Number),
    errorCode: 'RATE_LIMITED',
  });
  // The native log never names the actor or the organization, even of a verified token.
  expect(JSON.stringify(warn.mock.calls)).not.toContain(principal.organizationId);
  expect(JSON.stringify(warn.mock.calls)).not.toContain(principal.actorId);
  await Promise.all(tasks);
  expect(admission).toHaveBeenCalledExactlyOnceWith(
    {
      service: 'records',
      operation: 'readRecord',
      principal,
      requestId: principal.requestId,
      traceId: TRACE_ID,
      surface: 'http',
      occurredAt: expect.any(Number),
      durationMicros: expect.any(Number),
      errorCode: 'RATE_LIMITED',
    },
    on
  );
});

it('contains a failing admission observer, logging its request id alone, and still informs the others', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const admission = vi.fn(async () => undefined);
  const { tasks, context } = background();
  refuse(
    {
      observers: [
        {
          admission: async () => {
            throw new Error('PRIVATE exporter failure');
          },
        },
        { execution: async () => undefined },
        { admission },
      ],
    },
    on,
    context
  );
  await Promise.all(tasks);
  expect(tasks).toHaveLength(2);
  expect(admission).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ event: 'maximus.observer.delivery_failed', requestId: principal.requestId })
  );
});

it('logs an admission without observers, and records none unless telemetry and a context allow it', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const admission = vi.fn(async () => undefined);
  const telemetry: TelemetryConfig<Env> = {
    enabled: (env) => env.TELEMETRY === 'on',
    observers: [{ admission }],
  };
  const { tasks, context } = background();
  refuse(telemetry, off, context);
  refuse(telemetry, on, undefined);
  expect(warn).not.toHaveBeenCalled();
  refuse(undefined, on, context);
  expect(warn).toHaveBeenCalledOnce();
  expect(tasks).toEqual([]);
  expect(admission).not.toHaveBeenCalled();
});

it('still informs observers of an admission when the native console fails', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {
    throw new Error('console unavailable');
  });
  const admission = vi.fn(async () => undefined);
  const { tasks, context } = background();
  expect(() => refuse({ observers: [{ admission }] }, on, context)).not.toThrow();
  await Promise.all(tasks);
  expect(admission).toHaveBeenCalledOnce();
});
