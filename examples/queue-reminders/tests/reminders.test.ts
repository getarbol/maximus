/**
 * The reminders service in Node: the API that schedules a reminder and queues a message naming it, the
 * consumer that delivers it once however often the message arrives, refuses a message it never sends and
 * retries one it could not deliver, and the sweep that queues again what was never delivered.
 */
import { beforeEach, expect, it, vi } from 'vite-plus/test';

import { handler } from '#maximus/http';
import { reminderStore } from '#src/reminders.ts';
import type { Reminder, ReminderMessage } from '#src/reminders.ts';

import sweep from '../crons/sweep.ts';
import consume from '../queues/maximus-example-reminders.ts';
import { executionContext, testBatch, testNamespace, testQueue } from './stand-ins.ts';

/** The development token `vp test` accepts from localhost, as a developer holding every scope. */
const token = 'test-development-token-for-local-tests';
let queue: ReturnType<typeof testQueue<ReminderMessage>>;
let env: Env;

beforeEach(() => {
  queue = testQueue<ReminderMessage>();
  env = { DEVELOPMENT_TOKEN: token, REMINDERS: queue, REMINDER_STATE: testNamespace() } as Env;
  vi.restoreAllMocks();
});

/** Calls the API with the development token, sending `body` as JSON when there is one. */
async function call(method: string, path: string, body?: unknown) {
  const response = await handler(
    new Request(`http://localhost/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env
  );
  return { status: response.status, body: (await response.json()) as { data: unknown; error: unknown } };
}

/** Schedules a reminder through the API and answers it. */
async function scheduleReminder(text: string, delaySeconds?: number): Promise<Reminder> {
  return (await call('POST', '/v1/reminders', { text, delaySeconds })).body.data as Reminder;
}

it('stores a reminder and queues a message that names it, never its text', async () => {
  const created = await call('POST', '/v1/reminders', {
    text: 'Call the lab about the results',
    delaySeconds: 600,
  });
  expect(created).toMatchObject({ status: 202, body: { data: { status: 'pending' } } });
  const reminder = created.body.data as Reminder;
  expect(Date.parse(reminder.dueAt) - Date.now()).toBeGreaterThan(590_000);
  expect(queue.sent).toEqual([
    { body: { organizationId: 'local-development', reminderId: reminder.reminderId }, delaySeconds: 600 },
  ]);
  expect((await call('GET', `/v1/reminders/${reminder.reminderId}`)).body.data).toEqual(reminder);
});

it('delivers a reminder once, however often its message arrives', async () => {
  const reminder = await scheduleReminder('Renew the prescription');
  const { batch, outcomes } = testBatch([queue.sent[0]?.body, queue.sent[0]?.body]);
  await consume(batch, env, executionContext);
  expect(outcomes).toEqual(['ack', 'ack']);
  const delivered = (await call('GET', `/v1/reminders/${reminder.reminderId}`)).body.data as Reminder;
  expect(delivered).toMatchObject({ status: 'delivered', deliveredAt: expect.any(String) });
  await consume(testBatch([queue.sent[0]?.body], 2).batch, env, executionContext);
  expect((await call('GET', `/v1/reminders/${reminder.reminderId}`)).body.data).toEqual(delivered);
});

it('acknowledges a message it never sends, and retries one it could not deliver with a growing delay', async () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const reminder = await scheduleReminder('Book the follow-up visit');
  const unknown = { organizationId: 'local-development', reminderId: crypto.randomUUID() };
  const refused = testBatch([{ reminderId: 'not-a-uuid' }, 'text', unknown]);
  await consume(refused.batch, env, executionContext);
  // A reminder deleted since its message was sent has nothing left to deliver.
  expect(refused.outcomes).toEqual(['ack', 'ack', 'ack']);
  // The report names the refusal, never what the message held.
  expect(consoleError.mock.calls.flat().join('\n')).not.toContain('not-a-uuid');

  vi.spyOn(env.REMINDER_STATE, 'put').mockRejectedValue(new Error('KV is unavailable'));
  const failing = testBatch([queue.sent[0]?.body], 3);
  await consume(failing.batch, env, executionContext);
  expect(failing.outcomes).toEqual([{ retryAfter: 120 }]);
  expect(((await call('GET', `/v1/reminders/${reminder.reminderId}`)).body.data as Reminder).status).toBe(
    'pending'
  );
});

it('queues again each reminder still pending a quarter of an hour after it was due, and no other', async () => {
  const overdue = await scheduleReminder('Send the discharge summary');
  const later = await scheduleReminder('Check in next week', 43_200);
  const delivered = await scheduleReminder('Confirm the appointment');
  await consume(testBatch([queue.sent[2]?.body]).batch, env, executionContext);
  const elsewhere = await reminderStore(env.REMINDER_STATE, env.REMINDERS, 'org_lab').schedule(
    'Calibrate the analyzer'
  );
  // From here on, the queue records only what the sweep sends.
  queue.sent.length = 0;

  await sweep(
    { scheduledTime: Date.now() + 20 * 60_000, cron: '*/15 * * * *', noRetry() {} },
    env,
    executionContext
  );
  expect(queue.sent.map(({ body }) => body.reminderId).toSorted()).toEqual(
    [overdue.reminderId, elsewhere.reminderId].toSorted()
  );
  expect(queue.sent.map(({ body }) => body.reminderId)).not.toContain(later.reminderId);
  expect(queue.sent.map(({ body }) => body.reminderId)).not.toContain(delivered.reminderId);
});

it('refuses an empty text, a delay past twelve hours and another organization’s reminder', async () => {
  expect((await call('POST', '/v1/reminders', { text: '' })).status).toBe(400);
  expect((await call('POST', '/v1/reminders', { text: 'Later', delaySeconds: 43_201 })).status).toBe(400);
  expect(queue.sent).toEqual([]);
  const elsewhere = await reminderStore(env.REMINDER_STATE, env.REMINDERS, 'org_lab').schedule(
    'Order reagents'
  );
  expect(await call('GET', `/v1/reminders/${elsewhere.reminderId}`)).toMatchObject({
    status: 404,
    body: { error: { code: 'REMINDER_NOT_FOUND' } },
  });
});
