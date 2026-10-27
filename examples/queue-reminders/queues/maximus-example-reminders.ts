/**
 * The consumer of the reminders queue, named after it: delivers the reminder each message names. A message
 * this service never sends cannot succeed, so it is acknowledged and reported; one that fails is retried
 * with a growing delay, and after the trigger's last attempt moves to the dead letter queue.
 */
import { reportUnexpected } from '@arbol-ai/maximus';
import { checkSchema } from '@arbol-ai/maximus/schemas';

import { ReminderMessageSchema, reminderStore } from '#src/reminders.ts';

/** How long a message waits before its next attempt: 30 seconds, doubled for each attempt made. */
function retryDelaySeconds(attempts: number): number {
  return 30 * 2 ** (attempts - 1);
}

/** Delivers the reminder a message names and acknowledges the message, or retries it when delivery fails. */
async function deliverMessage(message: Message<unknown>, env: Env): Promise<void> {
  const checked = checkSchema(ReminderMessageSchema, message.body);
  if (!checked.success) {
    // Retrying a message this service never sends cannot make it succeed.
    reportUnexpected(checked.error, 'queue');
    message.ack();
    return;
  }
  const { organizationId, reminderId } = checked.data;
  try {
    // A reminder deleted since its message was sent has nothing left to deliver.
    await reminderStore(env.REMINDER_STATE, env.REMINDERS, organizationId).deliver(reminderId);
    message.ack();
  } catch (error) {
    reportUnexpected(error, 'queue');
    message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
  }
}

/** Delivers each message of the batch in turn. */
const consume: ExportedHandlerQueueHandler<Env, unknown> = async (batch, env) => {
  for (const message of batch.messages) {
    await deliverMessage(message, env);
  }
};

export default consume;
