/**
 * The analytics observer: one event of exactly the allowlisted metadata per operation call, matching its
 * schema, recorded only while its switch is on for the env; a sink that answers `ok: false` is a delivery
 * failure that never reaches the response or another observer.
 */
import { afterEach, expect, it, vi } from 'vite-plus/test';

import { analytics, ExecutionEventSchema } from '../../src/analytics/analytics.ts';
import type { ExecutionEvent } from '../../src/analytics/analytics.ts';
import { err, ok, parseInput, standardErrors } from '../../src/index.ts';
import type { ExecutionObservation } from '../../src/index.ts';
import { recordExecution } from '../../src/telemetry.ts';

/** The binding the analytics switch reads. */
interface Env {
  ANALYTICS: 'on' | 'off';
}

const on: Env = { ANALYTICS: 'on' };
const principal = {
  actorId: 'person-1',
  actorKind: 'user' as const,
  organizationId: 'org_1234567890abcdef',
  requestId: '00000000-0000-4000-8000-000000000001',
};
const observation: ExecutionObservation = {
  service: 'records',
  operation: 'readRecord',
  principal,
  surface: 'mcp',
  occurredAt: 1_790_000_000_000,
  durationMicros: 1250,
  outcome: 'failure',
  errorCode: 'NOT_FOUND',
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
};

afterEach(() => {
  vi.restoreAllMocks();
});

it('records each call as an event of exactly the allowlisted metadata, with an id of its own', async () => {
  const record = vi.fn(async (_env: Env, _event: ExecutionEvent) => undefined);
  const observer = analytics<Env>({ record, actor: 'id' });
  // An observation carrying more than its declared fields, as a widened object can at run time.
  const widened = {
    ...observation,
    input: { note: 'PRIVATE clinical note' },
    principal: { ...principal, token: 'PRIVATE bearer token' },
  };
  await observer.execution?.(widened, on);
  await observer.execution?.(widened, on);
  const [first, second] = record.mock.calls.map(([, event]) => event);
  expect(first).toEqual({
    id: expect.any(String),
    service: 'records',
    operation: 'readRecord',
    organizationId: principal.organizationId,
    actorId: principal.actorId,
    actorKind: 'user',
    requestId: principal.requestId,
    traceId: observation.traceId,
    surface: 'mcp',
    occurredAt: observation.occurredAt,
    durationMicros: 1250,
    outcome: 'failure',
    errorCode: 'NOT_FOUND',
  });
  expect(parseInput(ExecutionEventSchema, first).ok).toBe(true);
  expect(first?.id).not.toBe(second?.id);
  expect(record.mock.calls[0]?.[0]).toBe(on);
  expect(JSON.stringify(record.mock.calls)).not.toContain('PRIVATE');
});

it('names the actor by a pseudonym unless asked for its id: distinct per organization, never the id itself', async () => {
  const record = vi.fn(async (_env: Env, _event: ExecutionEvent) => undefined);
  const observer = analytics<Env>({ record });
  const email = { ...principal, actorId: 'patient.ana@example.test' };
  await observer.execution?.({ ...observation, principal: email }, on);
  await observer.execution?.({ ...observation, principal: email }, on);
  await observer.execution?.(
    { ...observation, principal: { ...email, organizationId: 'org_other0000000000' } },
    on
  );
  const [first, again, elsewhere] = record.mock.calls.map(([, event]) => event.actorId);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${principal.organizationId}:patient.ana@example.test`)
  );
  expect(first).toBe(Buffer.from(digest).toString('hex'));
  expect(again).toBe(first);
  expect(elsewhere).not.toBe(first);
  expect(JSON.stringify(record.mock.calls)).not.toContain('patient.ana');
});

it('never records an event that does not match its schema: the observer fails instead', async () => {
  const record = vi.fn(async () => undefined);
  await expect(
    analytics<Env>({ record }).execution?.({ ...observation, service: 'Records API' }, on)
  ).rejects.toThrow('The analytics event does not match ExecutionEventSchema.');
  expect(record).not.toHaveBeenCalled();
});

it('records nothing while its own switch is off for the env', async () => {
  const record = vi.fn(async () => undefined);
  const switched = analytics<Env>({ enabled: (env) => env.ANALYTICS === 'on', record });
  await switched.execution?.(observation, { ANALYTICS: 'off' });
  await analytics<Env>({ enabled: false, record }).execution?.(observation, on);
  expect(record).not.toHaveBeenCalled();
  await switched.execution?.(observation, on);
  expect(record).toHaveBeenCalledOnce();
});

it('counts a sink that answers ok: false as a delivery failure, and any other answer as kept', async () => {
  for (const answer of [undefined, null, 'stored', { stored: true }, ok(null), { ok: true }]) {
    await expect(
      analytics<Env>({ record: async () => answer }).execution?.(observation, on)
    ).resolves.toBeUndefined();
  }
  for (const answer of [err(standardErrors.upstreamUnavailable.create()), { ok: false }]) {
    await expect(analytics<Env>({ record: async () => answer }).execution?.(observation, on)).rejects.toThrow(
      'Analytics sink rejected the event.'
    );
  }
});

it('contains a rejected delivery as a logged failure, without affecting another observer', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const other = vi.fn(async () => undefined);
  const tasks: Promise<unknown>[] = [];
  recordExecution(
    {
      name: 'records',
      telemetry: {
        observers: [analytics<Env>({ record: async () => ({ ok: false }) }), { execution: other }],
      },
    },
    on,
    {
      waitUntil: (task) => {
        tasks.push(task);
      },
    },
    { principal, operation: 'readRecord', surface: 'http', started: performance.now(), result: ok({}) }
  );
  await Promise.all(tasks);
  expect(other).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ event: 'maximus.observer.delivery_failed', requestId: principal.requestId })
  );
});
