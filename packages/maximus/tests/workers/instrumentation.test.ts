/**
 * A Worker's own entrypoints and Durable Objects, wrapped by `createWorker`: every method a class defines or
 * inherits runs inside the diagnostics of its instance's env, with the application's observers, and the
 * class keeps its overrides, accessors, state, results and errors.
 */
/* oxlint-disable max-classes-per-file -- Wrapping walks class hierarchies: a base, its subclass and a Durable Object. */
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vite-plus/test';

import { defineErrors, maximus, reportUnexpected } from '../../src/index.ts';
import { diagnosticsEnabled } from '../../src/telemetry.ts';
import { createWorker } from '../../src/workers/runtime.ts';

/** The bindings the classes read: the telemetry switch and a label. */
interface Env {
  TELEMETRY: 'on' | 'off';
  LABEL: string;
}

const unexpected = vi.fn((_error: unknown, _surface: string, _requestId?: string) => undefined);
const app = maximus<Env>({
  name: 'reports',
  namespace: 'reports',
  title: 'Reports',
  version: '1',
  origin: 'https://reports.example.test',
  tokens: { issuer: 'https://issuer.example.test/', audience: 'reports' },
  errors: defineErrors({}),
  rpc: { callers: [] },
  telemetry: { enabled: (env) => env.TELEMETRY === 'on', observers: [{ error: unexpected }] },
}).build();
const worker = createWorker(app);
const on: Env = { TELEMETRY: 'on', LABEL: 'acme' };
const off: Env = { TELEMETRY: 'off', LABEL: 'acme' };
const context = {} as ExecutionContext;

afterEach(() => {
  vi.clearAllMocks();
});

/** A base entrypoint whose methods its subclass inherits or overrides. */
class SharedEntrypoint extends WorkerEntrypoint<Env> {
  heading(): string {
    return 'shared';
  }
  inherited(): boolean {
    return diagnosticsEnabled();
  }
}

/** An entrypoint a Worker exports: its own methods, an override, an accessor and a failing method. */
class ReportsEntrypoint extends SharedEntrypoint {
  override heading(): string {
    return `reports for ${this.env.LABEL}`;
  }
  get label(): string {
    return this.env.LABEL;
  }
  async summary(year: number): Promise<{ year: number; diagnostics: boolean }> {
    await Promise.resolve();
    return { year, diagnostics: diagnosticsEnabled() };
  }
  report(): void {
    reportUnexpected(new RangeError('PRIVATE report detail'), 'reports');
  }
  fail(): never {
    throw new RangeError('report unavailable');
  }
}

/** A Durable Object that counts in its own instance state. */
class CounterObject extends DurableObject<Env> {
  count = 0;
  async increment(): Promise<{ count: number; diagnostics: boolean }> {
    this.count += 1;
    await Promise.resolve();
    return { count: this.count, diagnostics: diagnosticsEnabled() };
  }
}

const Reports = worker.service(ReportsEntrypoint);

it('runs the methods a wrapped entrypoint defines or inherits inside the diagnostics of its env', async () => {
  expect(await new Reports(context, off).summary(2026)).toEqual({ year: 2026, diagnostics: false });
  expect(new Reports(context, off).inherited()).toBe(false);
  expect(await new Reports(context, on).summary(2026)).toEqual({ year: 2026, diagnostics: true });
  expect(new Reports(context, on).inherited()).toBe(true);
  // Unwrapped, the same class runs outside any diagnostics context, whatever its env says.
  expect(new ReportsEntrypoint(context, off).inherited()).toBe(true);
});

it('keeps each instance to its own env across interleaved asynchronous calls', async () => {
  const results = await Promise.all([
    new Reports(context, on).summary(1),
    new Reports(context, off).summary(2),
    new Reports(context, on).summary(3),
  ]);
  expect(results).toEqual([
    { year: 1, diagnostics: true },
    { year: 2, diagnostics: false },
    { year: 3, diagnostics: true },
  ]);
});

it("tells the application's observers of an unexpected error only while telemetry is on for the instance", () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    new Reports(context, off).report();
    expect(unexpected).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    new Reports(context, on).report();
    expect(unexpected).toHaveBeenCalledExactlyOnceWith(expect.any(RangeError), 'reports', undefined);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE');
  } finally {
    log.mockRestore();
  }
});

it("keeps the class's overrides, accessors, results, errors and identity", () => {
  const reports = new Reports(context, on);
  expect(reports.heading()).toBe('reports for acme');
  expect(reports.label).toBe('acme');
  expect(() => reports.fail()).toThrow(RangeError);
  expect(reports).toBeInstanceOf(ReportsEntrypoint);
  expect(reports).toBeInstanceOf(WorkerEntrypoint);
});

it("runs a wrapped Durable Object's methods inside the diagnostics of its env and keeps its state", async () => {
  const Counter = worker.durableObject(CounterObject);
  const counter = new Counter({} as DurableObjectState, off);
  expect(await counter.increment()).toEqual({ count: 1, diagnostics: false });
  expect(await counter.increment()).toEqual({ count: 2, diagnostics: false });
  expect(await new Counter({} as DurableObjectState, on).increment()).toEqual({
    count: 1,
    diagnostics: true,
  });
  expect(counter).toBeInstanceOf(CounterObject);
});

/** A Durable Object that binds a method to itself as it is constructed, as socket handlers often are. */
class SocketObject extends DurableObject<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.receive = this.receive.bind(this);
  }
  receive(): { diagnostics: boolean; bound: boolean } {
    return { diagnostics: diagnosticsEnabled(), bound: this instanceof SocketObject };
  }
}

it('lets a wrapped class rebind its methods as it is constructed, and the rebound method keeps its diagnostics', () => {
  const Socket = worker.durableObject(SocketObject);
  const { receive } = new Socket({} as DurableObjectState, off);
  expect(receive()).toEqual({ diagnostics: false, bound: true });
  expect(new Socket({} as DurableObjectState, on).receive()).toEqual({ diagnostics: true, bound: true });
});
