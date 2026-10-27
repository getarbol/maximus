# Background work

Besides answering calls, a Worker runs code on a schedule, for each batch of a queue, for each email it
receives, and after a response it has sent. This guide covers `crons/`, `queues/`, `email/` and
`background.waitUntil`, how to run each under `vp dev`, and how to test them.
[`examples/queue-reminders`](../../examples/queue-reminders) uses a cron and a queue together.

## Run code on a schedule

A module of `crons/` exports its schedule as a string literal, `export const cron`, and default-exports
the scheduled handler:

```ts
// crons/sweep.ts
import { overdueReminders } from '../src/reminders.ts';

/** Every quarter of an hour. */
export const cron = '*/15 * * * *';

/** How long past due a pending reminder waits for its own message before the sweep queues it again. */
const GRACE = 15 * 60 * 1000;

/** Queues again each reminder still pending a quarter of an hour after it was due. */
const sweep: ExportedHandlerScheduledHandler<Env> = async (controller, env) => {
  const overdue = await overdueReminders(env.REMINDER_STATE, controller.scheduledTime - GRACE);
  for (let start = 0; start < overdue.length; start += 100) {
    await env.REMINDERS.sendBatch(overdue.slice(start, start + 100).map((body) => ({ body })));
  }
};

export default sweep;
```

The handler receives the event's controller (its `cron` and `scheduledTime`), the bindings and the execution
context. From the files, Maximus gives the Worker its cron triggers:

- Each distinct schedule becomes one trigger. Modules that state the same schedule share it, and every one
  of them runs when it fires, side by side; when one fails, the event fails, and the others still run.
- A scheduled trigger that `triggers` in `maximus()` declares for the same schedule is kept as it is.
- The schedule is a string literal in an exported `const`. Anything else stops `vp dev`, `vp build` and
  `vp test` with `<file>: export the schedule as a string literal, export const cron = '0 8 * * *'.`
- A schedule that `triggers` declares and no module states fails each time it fires.

Under `vp dev`, adding or removing a cron module, or changing a schedule, restarts the server so the
Worker's triggers follow the files.

## Consume a queue

A queue has two halves: the binding the Worker sends messages through, and a module of `queues/` named after
the queue, which consumes them.

```ts
// vite.config.ts, in maximus()
env: {
  REMINDERS: bindings.queue({ name: 'reminders' }),
  REMINDER_STATE: bindings.kv(),
},
```

```ts
// queues/reminders.ts
import { reportUnexpected } from '@arbol-ai/maximus';
import { checkSchema } from '@arbol-ai/maximus/schemas';

import { ReminderMessageSchema, reminderStore } from '../src/reminders.ts';

/** Delivers the reminder each message names, once however often the message arrives. */
const consume: ExportedHandlerQueueHandler<Env, unknown> = async (batch, env) => {
  for (const message of batch.messages) {
    const checked = checkSchema(ReminderMessageSchema, message.body);
    if (!checked.success) {
      // A message this service never sends cannot succeed: acknowledge it, and report it.
      reportUnexpected(checked.error, 'queue');
      message.ack();
      continue;
    }
    const { organizationId, reminderId } = checked.data;
    try {
      await reminderStore(env.REMINDER_STATE, organizationId).deliver(reminderId);
      message.ack();
    } catch (error) {
      reportUnexpected(error, 'queue');
      message.retry({ delaySeconds: 30 * 2 ** (message.attempts - 1) });
    }
  }
};

export default consume;
```

The Worker hands each batch to the module named after the batch's queue. `queues/reminders.ts` also
subscribes the Worker to `reminders`, with Cloudflare's defaults for the batch size and the retries. To
choose them, declare the consumer in `triggers`, and Maximus keeps that declaration instead:

```ts
// vite.config.ts
import { maximus } from '@arbol-ai/maximus/vite';
import { bindings, triggers } from 'cf/config';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [
    maximus({
      origin: 'https://reminders.example.com',
      tokens: { issuer: 'https://auth.example.com/' },
      compatibilityDate: '2026-10-27',
      env: {
        REMINDERS: bindings.queue({ name: 'reminders' }),
        REMINDER_STATE: bindings.kv(),
      },
      // Batches of ten, and five retries before a message moves to the dead letter queue.
      triggers: [
        triggers.queue({
          name: 'reminders',
          maxBatchSize: 10,
          maxRetries: 5,
          deadLetterQueue: 'reminders-dead',
        }),
      ],
    }),
  ],
});
```

`triggers.queue` also takes `maxBatchTimeout`, `maxConcurrency`, `retryDelay` and `visibilityTimeoutMs`.

What the consumer above does, every consumer should:

- **Check each message.** A message is input like any other: `checkSchema` refuses one the service never
  sends, and `reportUnexpected` reports the refusal by its safe description, never the message's content.
- **Settle each message.** `message.ack()` once it is handled, `message.retry({ delaySeconds })` to try it
  again later. When the handler returns, a message it neither acknowledged nor retried counts as delivered;
  when the handler throws, the whole batch is retried.
- **Deliver once.** A queue delivers each message at least once, so a message may arrive again after it was
  handled. The reminders' store delivers a reminder once however often its message arrives.
- **Name, never carry.** A reminder's message names its organization and its reminder, never what the
  reminder says, so neither the queue, its retries nor its dead letters ever hold the content.

After `maxRetries` retries, a message moves to the dead letter queue, which keeps it for inspection, or is
dropped when the consumer names none. A batch from a queue that no module is named after fails, so the queue
retries it rather than lose it.

## Receive email

A module of `email/` is named after the full address it receives mail for, and `email/_default.ts` receives
mail for every other address. Each default-exports an email handler:

```ts
// email/help@example.com.ts
/** Mail to help@example.com goes to the support team's inbox. */
const receive: EmailExportedHandler<Env> = async (message) => {
  await message.forward('support-team@example.com');
};

export default receive;
```

```ts
// email/_default.ts
/** Mail to any other address is refused. */
const refuse: EmailExportedHandler<Env> = (message) => {
  message.setReject('Unknown recipient.');
};

export default refuse;
```

A message reaches the module named exactly after its recipient, else `_default`. Without either, the
Worker rejects it with `This recipient is not configured.` `forward` sends a message on to a verified
destination address of the account, and `setReject` refuses it with a permanent SMTP error.

The Worker receives mail only for the addresses routed to it. Maximus adds no email trigger: declare the
addresses in `triggers` with `triggers.email({ addresses: ['help@example.com'] })`, and a deployment applies
them to Email Routing.

A recipient's domain may end like a mode or a test suffix: `email/help@example.dev.ts` handles mail to
`help@example.dev`, while `email/help@example.com.dev.ts` is the development handler of
`help@example.com`.

## Work after the response

A handler's `background` keeps work running after the response is sent:

```ts
// routes/v1/notes/index.post.ts
import { defineHandler, t } from '@arbol-ai/maximus';

import { NoteSchema } from '../../../src/notes.ts';

/** POST /api/v1/notes: a new note, and, after the response, when the organization last wrote one. */
export default defineHandler(
  async ({ input, notes, env, principal, background }) => {
    const note = await notes.create(input.text);
    background?.waitUntil(env.NOTES.put(`activity/${principal.organizationId}`, note.createdAt));
    return note;
  },
  {
    description: 'Write a note for the organization.',
    input: { text: t.String({ minLength: 1, maxLength: 2000 }) },
    output: NoteSchema,
    http: { successStatus: 201 },
  }
);
```

`background.waitUntil(promise)` is best effort: the platform bounds how long the work runs after the
response, and nothing retries it when it fails. Work that must happen goes to a queue. `background` is
absent when nothing runs the handler with a runtime context, as when a test calls `handler(request, env)`,
hence `background?.`. A page's `context.waitUntil` does the same for a page, and a scheduled, queue or email
handler receives the execution context itself as its third argument.

## Failures

Scheduled, queue and email handlers run inside the application's diagnostics. An exception is reported as a
`maximus.unexpected` event with its surface (`scheduled`, `queue` or `email`) and its safe description,
then thrown on, so the platform records the failed event or retries the batch as it would without Maximus.
See [Observability](observability.md).

## Run it under vp dev

Under `vp dev`, the Worker runs every trigger locally:

- **A schedule** runs when Cloudflare's Local Explorer asks for it, with the Worker's name and the schedule:

  ```sh
  curl -X POST 'http://localhost:5173/cdn-cgi/local/explorer/api/local/scheduled?worker=reminders' \
    -H 'content-type: application/json' -d '{"cron":"*/15 * * * *"}'
  ```

  ```json
  { "success": true, "errors": [], "messages": [], "result": { "outcome": "ok", "noRetry": false } }
  ```

  The outcome is `exception` when a handler throws or no module states the schedule.
  `GET /cdn-cgi/local/scheduled?cron=*/15+*+*+*+*` runs it too, and answers `ok` or `exception`.

- **A queue** delivers what the Worker sends to its consumer within the same server, so a reminder the API
  schedules is delivered within a second.

- **Email** arrives at `/cdn-cgi/local/email`, with the sender and the recipient in the query and a raw
  message, headers and a `Message-ID` included, as the body:

  ```sh
  curl -X POST 'http://localhost:5173/cdn-cgi/local/email?from=sender@example.net&to=help@example.com' \
    --data-binary @message.eml
  ```

  It answers `Worker successfully processed email`, or `400` with the reason a handler gave `setReject`.

## Test it

Each module's default export is a function of its event, its bindings and its context, so a test in Node
calls it directly, with stand-ins for what the module uses:

```ts
// tests/reminders.test.ts
import { expect, it } from 'vite-plus/test';

import sweep from '../crons/sweep.ts';
import consume from '../queues/reminders.ts';
import { reminderStore } from '../src/reminders.ts';
import type { ReminderMessage } from '../src/reminders.ts';
import { testBatch, testNamespace, testQueue } from './stand-ins.ts';

const context = {} as ExecutionContext;

it('delivers a reminder once, however often its message arrives', async () => {
  const env = { REMINDERS: testQueue<ReminderMessage>(), REMINDER_STATE: testNamespace() } as unknown as Env;
  const reminder = await reminderStore(env.REMINDER_STATE, 'org_1234567890abcdef').create('Call back', 0);
  const message = { organizationId: 'org_1234567890abcdef', reminderId: reminder.reminderId };
  const { batch, outcomes } = testBatch([message, message]);
  await consume(batch, env, context);
  expect(outcomes).toEqual(['ack', 'ack']);
});

it('queues again a reminder still pending after its grace period', async () => {
  const queue = testQueue<ReminderMessage>();
  const env = { REMINDERS: queue, REMINDER_STATE: testNamespace() } as unknown as Env;
  const reminder = await reminderStore(env.REMINDER_STATE, 'org_1234567890abcdef').create('Call back', 0);
  await sweep({ cron: '*/15 * * * *', scheduledTime: Date.now() + 20 * 60_000, noRetry() {} }, env, context);
  expect(queue.sent.map(({ body }) => body.reminderId)).toEqual([reminder.reminderId]);
});
```

[`examples/queue-reminders/tests/stand-ins.ts`](../../examples/queue-reminders/tests/stand-ins.ts) holds
the stand-ins: a KV namespace with metadata, a queue that records what it is sent, and a batch that records
what the consumer did with each message. An email handler is tested the same way, with a message whose
`setReject` and `forward` record their calls.

End to end, [`e2e/reminders.e2e.test.ts`](../../e2e/reminders.e2e.test.ts) schedules a reminder through
the running Worker's API and waits until its consumer has delivered it. See [Testing](testing.md).
