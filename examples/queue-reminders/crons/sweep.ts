/**
 * Every quarter of an hour, queues again each reminder still pending a quarter of an hour after it was due:
 * its message was never sent, or was lost. The consumer delivers a reminder once, however often it arrives.
 */
import { overdueReminders } from '../src/reminders.ts';

export const cron = '*/15 * * * *';

/** How long past due a pending reminder waits for its own message before the sweep queues it again. */
const GRACE = 15 * 60 * 1000;
/** The most messages one `sendBatch` takes. */
const BATCH = 100;

const sweep: ExportedHandlerScheduledHandler<Env> = async (controller, env) => {
  const overdue = await overdueReminders(env.REMINDER_STATE, controller.scheduledTime - GRACE);
  for (let start = 0; start < overdue.length; start += BATCH) {
    await env.REMINDERS.sendBatch(overdue.slice(start, start + BATCH).map((body) => ({ body })));
  }
};

export default sweep;
