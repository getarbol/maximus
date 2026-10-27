/**
 * A project's background events: cron, queue and email modules compose with the Worker's explicit fallbacks and
 * receive the platform's arguments, and an event that neither handles fails closed: an unmatched cron trigger
 * or queue batch is refused so the platform retries it, and an unmatched email is rejected, never dropped.
 */
import { describe, expect, it, vi } from 'vite-plus/test';

import { projectHandlers } from '../../src/project/handlers.ts';

interface Env {
  REGION: string;
}

const env: Env = { REGION: 'eu' };
const context = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;

/** A cron trigger's controller, as the platform passes it. */
function trigger(cron: string): ScheduledController {
  return { cron, scheduledTime: 1_760_000_000_000, noRetry: vi.fn() } as unknown as ScheduledController;
}

/** A batch from a physical queue, as the platform passes it. */
function batch(queue: string): MessageBatch {
  return { queue, messages: [], ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch;
}

/** An incoming email, as Email Routing passes it. */
function email(to: string) {
  const setReject = vi.fn();
  const message = { from: 'patient@example.test', to, setReject } as unknown as ForwardableEmailMessage;
  return { message, setReject };
}

describe('cron modules', () => {
  it('all run for their schedule, with the controller, bindings and context, and no other schedule runs', async () => {
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    const hourly = vi.fn(async () => undefined);
    const handlers = projectHandlers<Env>({
      crons: [
        { cron: '0 8 * * *', handler: first },
        { cron: '0 * * * *', handler: hourly },
        { cron: '0 8 * * *', handler: second },
      ],
    });
    const controller = trigger('0 8 * * *');
    await handlers.scheduled?.(controller, env, context);
    expect(first).toHaveBeenCalledWith(controller, env, context);
    expect(second).toHaveBeenCalledWith(controller, env, context);
    expect(hourly).not.toHaveBeenCalled();
  });

  it('run with the Worker handler as this, as the platform calls it', async () => {
    const seen: unknown[] = [];
    const handlers = projectHandlers<Env>({
      crons: [
        {
          cron: '0 8 * * *',
          async handler() {
            seen.push(this);
          },
        },
      ],
    });
    await handlers.scheduled?.(trigger('0 8 * * *'), env, context);
    expect(seen).toEqual([handlers]);
  });

  it('fail the trigger when one module fails, and still start its siblings', async () => {
    const sibling = vi.fn(async () => undefined);
    const handlers = projectHandlers<Env>({
      crons: [
        {
          cron: '0 8 * * *',
          handler: async () => {
            throw new Error('The reminder store is unavailable.');
          },
        },
        { cron: '0 8 * * *', handler: sibling },
      ],
    });
    await expect(handlers.scheduled?.(trigger('0 8 * * *'), env, context)).rejects.toThrow(
      'The reminder store is unavailable.'
    );
    expect(sibling).toHaveBeenCalledOnce();
  });

  it('leave an unmatched schedule to the explicit fallback, and fail it without one', async () => {
    const daily = vi.fn(async () => undefined);
    const scheduled = vi.fn(async () => undefined);
    const crons = [{ cron: '0 8 * * *', handler: daily }];
    const controller = trigger('*/5 * * * *');
    await projectHandlers<Env>({ crons }, { scheduled }).scheduled?.(controller, env, context);
    expect(scheduled).toHaveBeenCalledWith(controller, env, context);
    await expect(projectHandlers<Env>({ crons }).scheduled?.(controller, env, context)).rejects.toThrow(
      'No module handles this cron trigger.'
    );
    expect(daily).not.toHaveBeenCalled();
  });

  it('must state a nonempty expression, which composing the Worker checks', () => {
    for (const cron of ['', '   ']) {
      expect(() => projectHandlers<Env>({ crons: [{ cron, handler: async () => undefined }] })).toThrow(
        new TypeError('A cron module must export a nonempty cron expression.')
      );
    }
  });
});

describe('queue modules', () => {
  it('receive the batches of the physical queue they are named after', async () => {
    const notifications = vi.fn(async () => undefined);
    const exports = vi.fn(async () => undefined);
    const handlers = projectHandlers<Env>({ queues: { notifications, exports } });
    const delivered = batch('notifications');
    await handlers.queue?.(delivered, env, context);
    expect(notifications).toHaveBeenCalledWith(delivered, env, context);
    expect(exports).not.toHaveBeenCalled();
  });

  it('leave an unknown queue to the fallback, and without one refuse the batch so it is retried', async () => {
    const queue = vi.fn(async () => undefined);
    const queues = { notifications: vi.fn(async () => undefined) };
    const unknown = batch('audit');
    await projectHandlers<Env>({ queues }, { queue }).queue?.(unknown, env, context);
    expect(queue).toHaveBeenCalledWith(unknown, env, context);
    await expect(projectHandlers<Env>({ queues }).queue?.(unknown, env, context)).rejects.toThrow(
      'No module handles this queue; the batch must be retried.'
    );
    // Refusing is how the platform retries: nothing acknowledged the batch.
    expect(unknown.ackAll).not.toHaveBeenCalled();
  });
});

describe('email modules', () => {
  it('receive mail for their exact recipient, then for _default, then the fallback does', async () => {
    const help = vi.fn(async () => undefined);
    const fallbackDefault = vi.fn(async () => undefined);
    const fallback = vi.fn(async () => undefined);
    const helpMail = email('help@example.test');
    await projectHandlers<Env>({ email: { 'help@example.test': help } }).email?.(
      helpMail.message,
      env,
      context
    );
    expect(help).toHaveBeenCalledWith(helpMail.message, env, context);
    const salesMail = email('sales@example.test');
    await projectHandlers<Env>(
      { email: { 'help@example.test': help, _default: fallbackDefault } },
      { email: fallback }
    ).email?.(salesMail.message, env, context);
    expect(fallbackDefault).toHaveBeenCalledWith(salesMail.message, env, context);
    expect(fallback).not.toHaveBeenCalled();
    await projectHandlers<Env>({ email: { 'help@example.test': help } }, { email: fallback }).email?.(
      salesMail.message,
      env,
      context
    );
    expect(fallback).toHaveBeenCalledWith(salesMail.message, env, context);
    expect(help).toHaveBeenCalledOnce();
  });

  it('reject mail that no module or fallback handles, rather than dropping it', async () => {
    const help = vi.fn(async () => undefined);
    const { message, setReject } = email('billing@example.test');
    await projectHandlers<Env>({ email: { 'help@example.test': help } }).email?.(message, env, context);
    expect(setReject).toHaveBeenCalledWith('This recipient is not configured.');
    expect(help).not.toHaveBeenCalled();
  });
});

it("keeps the fallback's handlers as they are when no module of their kind is discovered", () => {
  const fallback = {
    scheduled: vi.fn(async () => undefined),
    queue: vi.fn(async () => undefined),
    email: vi.fn(async () => undefined),
    tail: vi.fn(async () => undefined),
  };
  const handlers = projectHandlers<Env>({ crons: [], queues: {}, email: {} }, fallback);
  expect(handlers).toEqual(fallback);
  expect(handlers).not.toBe(fallback);
  expect(projectHandlers<Env>({})).toEqual({});
  // Discovered modules replace only their own kind.
  const composed = projectHandlers<Env>({ queues: { jobs: vi.fn(async () => undefined) } }, fallback);
  expect(composed.queue).not.toBe(fallback.queue);
  expect(composed).toMatchObject({
    scheduled: fallback.scheduled,
    email: fallback.email,
    tail: fallback.tail,
  });
});
