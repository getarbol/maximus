/**
 * Every quarter of an hour, queues again each reminder still pending a quarter of an hour after it was due:
 * its message was never sent, or was lost. The consumer delivers a reminder once, however often it arrives.
 */
import { findOverdueReminders, sendInBatches } from '#src/reminders.ts';

/** When the sweep runs: every quarter of an hour. */
export const cron = '*/15 * * * *';

/** How long past due a pending reminder waits for its own message before the sweep queues it again. */
const GRACE_PERIOD_MS = 15 * 60 * 1000;

/** Queues again each reminder still pending once its grace period is over. */
const sweep: ExportedHandlerScheduledHandler<Env> = async (controller, env) => {
  const dueBeforeMs = controller.scheduledTime - GRACE_PERIOD_MS;
  const overdueReminders = await findOverdueReminders(env.REMINDER_STATE, dueBeforeMs);
  await sendInBatches(env.REMINDERS, overdueReminders);
};

export default sweep;
