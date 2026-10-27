/**
 * `createWorker` in Node: the RPC entrypoint admits only the callers its Service Binding props name and the
 * operation allows, refuses a malformed principal, fails closed for conditional operations and observes
 * each call without its input or output; the default handler serves HTTP, static assets or the HTTP
 * fallback, and runs the scheduled handler inside the application's diagnostics.
 */
import { afterEach, expect, it, vi } from 'vite-plus/test';

import { defineErrors, maximus, ok, reportUnexpected, standardErrors, t } from '../../src/index.ts';
import type { ExecutionObservation, Principal } from '../../src/index.ts';
import { diagnosticsEnabled } from '../../src/telemetry.ts';
import { createWorker } from '../../src/workers/runtime.ts';
import { tracing } from './fixtures/cloudflare-workers.ts';

/** The bindings the Worker reads: its telemetry switch and its build files. */
interface Env {
  TELEMETRY: 'on' | 'off';
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

/** Which operations ran, and whether diagnostics were on inside them. */
const runs: { operation: string; diagnostics: boolean }[] = [];
const execution = vi.fn(async (_event: ExecutionObservation, _env: Env) => undefined);
const unexpected = vi.fn((_error: unknown, _surface: string, _requestId?: string) => undefined);

const RecordInput = t.Object(
  { recordId: t.String({ pattern: '^rec_[a-z0-9]+$' }) },
  { additionalProperties: false }
);
const Count = t.Object({ count: t.Integer() }, { additionalProperties: false });
const Empty = t.Object({}, { additionalProperties: false });
const app = maximus<Env>({
  name: 'records',
  namespace: 'records',
  title: 'Records',
  version: '1',
  origin: 'https://records.example.test',
  tokens: { issuer: 'https://issuer.example.test/', audience: 'records' },
  errors: defineErrors({}),
  rpc: { callers: ['orders', 'reports'] },
  telemetry: {
    enabled: (env) => env.TELEMETRY === 'on',
    observers: [{ execution, error: unexpected }],
  },
})
  .operation(
    'readRecord',
    {
      scope: 'records:records:read',
      title: 'Read a record',
      description: 'Read one record of the calling organization.',
      effect: 'read',
      input: RecordInput,
      output: t.Object({ recordId: t.String(), organizationId: t.String() }, { additionalProperties: false }),
      http: { method: 'POST', path: '/v1/records/read' },
      rpc: { callers: ['orders'] },
    },
    async ({ principal }, input) => {
      runs.push({ operation: 'readRecord', diagnostics: diagnosticsEnabled() });
      return ok({ recordId: input.recordId, organizationId: principal.organizationId });
    }
  )
  .operation(
    'countRecords',
    {
      scope: 'records:records:read',
      title: 'Count records',
      description: 'Count the records of the calling organization.',
      effect: 'read',
      input: Empty,
      output: Count,
      rpc: true,
    },
    async () => {
      runs.push({ operation: 'countRecords', diagnostics: diagnosticsEnabled() });
      return ok({ count: 3 });
    }
  )
  .operation(
    'archiveRecord',
    {
      scope: 'records:records:write',
      conditionalScopes: ['records:records:archive'],
      title: 'Archive a record',
      description: 'Archive one record when the caller may archive it.',
      effect: 'write',
      input: RecordInput,
      output: Empty,
      rpc: true,
    },
    async () => {
      runs.push({ operation: 'archiveRecord', diagnostics: diagnosticsEnabled() });
      return ok({});
    }
  )
  .operation(
    'exportRecords',
    {
      scope: 'records:records:read',
      title: 'Export records',
      description: 'Export the records of the calling organization.',
      effect: 'read',
      input: Empty,
      output: Count,
      http: { method: 'POST', path: '/v1/records/export' },
    },
    async () => {
      runs.push({ operation: 'exportRecords', diagnostics: diagnosticsEnabled() });
      return ok({ count: 0 });
    }
  )
  .build();

const claims = {
  sub: 'orders@clients',
  client_id: 'orders',
  org_id: 'org_1234567890abcdef',
  scope: 'records:records:read',
};
const worker = createWorker(app, { http: { verify: async () => claims } });
const principal: Principal = {
  actorId: 'person-1',
  actorKind: 'user',
  organizationId: 'org_1234567890abcdef',
  requestId: '00000000-0000-4000-8000-000000000001',
};
const on: Env = { TELEMETRY: 'on', ASSETS: { fetch: async () => new Response('<!doctype html>') } };
const off: Env = { ...on, TELEMETRY: 'off' };

const installed = tracing.getActiveSpan;
afterEach(() => {
  runs.length = 0;
  vi.clearAllMocks();
  if (installed) {
    tracing.getActiveSpan = installed;
  } else {
    delete tracing.getActiveSpan;
  }
});

/** The parts of an ExecutionContext the runtime reads: the Service Binding's props and `waitUntil`. */
function executionContext(props: unknown, background: Promise<unknown>[] = []): ExecutionContext {
  return {
    props,
    waitUntil: (task: Promise<unknown>) => {
      background.push(task);
    },
  } as ExecutionContext;
}

/** Installs an active span and returns the attributes each annotation sets on it. */
function activeSpan(): Record<string, unknown>[] {
  const annotations: Record<string, unknown>[] = [];
  tracing.getActiveSpan = () => ({
    setAttributes: (attributes) => {
      annotations.push(attributes);
    },
  });
  return annotations;
}

/** Answers a request with a Worker's default export, as the runtime calls it with an incoming request. */
async function serve(
  handler: ExportedHandler<Env>,
  url: string,
  env: Env,
  init?: RequestInit
): Promise<Response> {
  // Only the runtime attaches the `cf` properties of an incoming request; the handler reads none of them.
  const request = new Request(url, init) as Request<unknown, IncomingRequestCfProperties>;
  const response = await handler.fetch?.(request, env, executionContext(undefined));
  if (!response) {
    throw new TypeError('The Worker has no fetch handler.');
  }
  return response;
}

it('runs an RPC operation for a caller its Service Binding props name, as the forwarded principal', async () => {
  const background: Promise<unknown>[] = [];
  const records = new worker.entrypoint(executionContext({ caller: 'orders' }, background), on);
  expect(await records.readRecord(principal, { recordId: 'rec_private1' })).toEqual({
    ok: true,
    value: { recordId: 'rec_private1', organizationId: principal.organizationId },
  });
  expect(runs).toEqual([{ operation: 'readRecord', diagnostics: true }]);
  await Promise.all(background);
  expect(execution).toHaveBeenCalledExactlyOnceWith(
    {
      service: 'records',
      operation: 'readRecord',
      principal,
      surface: 'rpc',
      occurredAt: expect.any(Number),
      durationMicros: expect.any(Number),
      outcome: 'success',
      errorCode: null,
      traceId: null,
    },
    on
  );
  // An observation is metadata: neither the input nor the output reaches an observer.
  expect(JSON.stringify(execution.mock.calls)).not.toContain('rec_private1');
});

it('admits every application caller to an operation that declares rpc: true, and no other', async () => {
  for (const caller of ['orders', 'reports']) {
    const records = new worker.entrypoint(executionContext({ caller }), on);
    expect(await records.countRecords(principal, {})).toEqual({ ok: true, value: { count: 3 } });
  }
  const stranger = new worker.entrypoint(executionContext({ caller: 'billing' }), on);
  expect(await stranger.countRecords(principal, {})).toEqual({
    ok: false,
    error: standardErrors.unauthorized.create(),
  });
});

it('refuses props that are not exactly one caller the operation admits, before anything runs', async () => {
  const background: Promise<unknown>[] = [];
  for (const props of [
    undefined,
    null,
    {},
    'orders',
    // An application caller that this operation does not name.
    { caller: 'reports' },
    { caller: 'billing' },
    { caller: 'orders', role: 'admin' },
    { caller: ['orders'] },
  ]) {
    const records = new worker.entrypoint(executionContext(props, background), on);
    expect(await records.readRecord(principal, { recordId: 'rec_1' })).toEqual({
      ok: false,
      error: standardErrors.unauthorized.create(),
    });
  }
  expect(runs).toEqual([]);
  expect(background).toEqual([]);
});

it('refuses a malformed or forged principal before the operation runs', async () => {
  const records = new worker.entrypoint(executionContext({ caller: 'orders' }), on);
  for (const forged of [
    { ...principal, organizationId: 'acme/other' },
    { ...principal, scopes: ['records:records:archive'] },
    { ...principal, requestId: 'not-a-uuid' },
    { ...principal, actorKind: 'admin' },
    { actorId: principal.actorId, actorKind: principal.actorKind, organizationId: principal.organizationId },
    null,
    principal.organizationId,
  ]) {
    // The calling Worker is not type-checked by the owner: its principal arrives as any serializable value.
    expect(await records.readRecord(forged as Principal, { recordId: 'rec_1' })).toEqual({
      ok: false,
      error: standardErrors.unauthorized.create(),
    });
  }
  expect(runs).toEqual([]);
});

it('fails closed for conditional scopes over RPC and observes refused calls by their code alone', async () => {
  const background: Promise<unknown>[] = [];
  const reports = new worker.entrypoint(executionContext({ caller: 'reports' }, background), on);
  expect(await reports.archiveRecord(principal, { recordId: 'rec_1' })).toMatchObject({
    ok: false,
    error: { code: 'FORBIDDEN' },
  });
  const orders = new worker.entrypoint(executionContext({ caller: 'orders' }, background), on);
  expect(await orders.readRecord(principal, { recordId: 'PRIVATE value' })).toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT' },
  });
  expect(runs).toEqual([]);
  await Promise.all(background);
  expect(execution.mock.calls.map(([event]) => [event.operation, event.outcome, event.errorCode])).toEqual([
    ['archiveRecord', 'failure', 'FORBIDDEN'],
    ['readRecord', 'failure', 'INVALID_INPUT'],
  ]);
  expect(JSON.stringify(execution.mock.calls)).not.toContain('PRIVATE');
});

it('exposes only the operations that declare rpc as entrypoint methods', () => {
  const records = new worker.entrypoint(executionContext({ caller: 'orders' }), on);
  expect(
    ['readRecord', 'countRecords', 'archiveRecord', 'exportRecords'].filter((name) => name in records)
  ).toEqual(['readRecord', 'countRecords', 'archiveRecord']);
});

it('annotates the active span with the service, the operation and the forwarded request id', async () => {
  const annotations = activeSpan();
  const records = new worker.entrypoint(executionContext({ caller: 'orders' }), on);
  await records.readRecord(principal, { recordId: 'rec_1' });
  expect(annotations).toEqual([
    { 'service.name': 'records', 'operation.name': 'readRecord', 'request.id': principal.requestId },
  ]);
});

it('neither annotates nor observes a call while telemetry is off for its env, and answers the same', async () => {
  const annotations = activeSpan();
  const background: Promise<unknown>[] = [];
  const records = new worker.entrypoint(executionContext({ caller: 'orders' }, background), off);
  expect(await records.readRecord(principal, { recordId: 'rec_1' })).toEqual({
    ok: true,
    value: { recordId: 'rec_1', organizationId: principal.organizationId },
  });
  expect(runs).toEqual([{ operation: 'readRecord', diagnostics: false }]);
  expect(annotations).toEqual([]);
  expect(background).toEqual([]);
});

it('keeps the result of an RPC call when the span API fails', async () => {
  tracing.getActiveSpan = () => {
    throw new Error('tracing unavailable');
  };
  const records = new worker.entrypoint(executionContext({ caller: 'orders' }), on);
  expect(await records.readRecord(principal, { recordId: 'rec_1' })).toEqual({
    ok: true,
    value: { recordId: 'rec_1', organizationId: principal.organizationId },
  });
});

it('serves HTTP operations from the default handler and annotates the span with their request id', async () => {
  const annotations = activeSpan();
  const response = await serve(worker.handler, 'https://records.example.test/v1/records/read', on, {
    method: 'POST',
    headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json' },
    body: JSON.stringify({ recordId: 'rec_1' }),
  });
  expect(response.status).toBe(200);
  expect(annotations).toEqual([
    {
      'service.name': 'records',
      'operation.name': 'readRecord',
      'request.id': response.headers.get('x-request-id'),
    },
  ]);
});

it('runs the scheduled handler inside the diagnostics of its env and merges the other handlers as written', async () => {
  const seen: boolean[] = [];
  const scheduled = vi.fn(async (_controller: ScheduledController, _env: Env, _ctx: ExecutionContext) => {
    seen.push(diagnosticsEnabled());
    reportUnexpected(new RangeError('PRIVATE schedule detail'), 'scheduled');
  });
  const queue = vi.fn(async () => undefined);
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const { handler } = createWorker(app, { handlers: { scheduled, queue } });
    expect(handler.queue).toBe(queue);
    const controller: ScheduledController = { cron: '0 * * * *', scheduledTime: 0, noRetry: () => undefined };
    await handler.scheduled?.(controller, off, executionContext(undefined));
    await handler.scheduled?.(controller, on, executionContext(undefined));
    expect(seen).toEqual([false, true]);
    expect(scheduled).toHaveBeenLastCalledWith(controller, on, expect.anything());
    expect(scheduled.mock.contexts[1]).toBe(handler);
    // Only the run whose env turns telemetry on reports, by the error's safe description alone.
    expect(unexpected).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE');
  } finally {
    log.mockRestore();
  }
});

it('refuses static assets beside an HTTP fallback, since both would own unmatched paths', () => {
  expect(() =>
    createWorker(app, {
      assets: { binding: 'ASSETS', pages: { paths: ['/settings'] } },
      http: { fallback: async () => new Response('fallback') },
    })
  ).toThrow(TypeError);
});

it('serves static assets, or else the HTTP fallback, at paths outside the API', async () => {
  const withAssets = createWorker(app, { assets: { binding: 'ASSETS', pages: { paths: ['/settings'] } } });
  const page = await serve(withAssets.handler, 'https://records.example.test/settings', on);
  expect(await page.text()).toBe('<!doctype html>');
  expect(page.headers.get('cache-control')).toBe('no-store');
  const fallback = vi.fn(async () => new Response('fallback'));
  const withFallback = createWorker(app, { http: { fallback } });
  const other = await serve(withFallback.handler, 'https://records.example.test/settings', on);
  expect(await other.text()).toBe('fallback');
  // A versioned API path is never handed to the fallback.
  const api = await serve(withFallback.handler, 'https://records.example.test/v1/unknown', on);
  expect(api.status).toBe(404);
  expect(fallback).toHaveBeenCalledOnce();
});
