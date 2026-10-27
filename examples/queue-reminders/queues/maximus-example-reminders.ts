/**
 * The consumer of the reminders queue, named after it: delivers the reminder each message names. A message
 * this service never sends cannot succeed, so it is acknowledged and reported; one that fails is retried
 * with a growing delay, and after the trigger's last attempt moves to the dead letter queue.
 */
import { reportUnexpected } from '@arbol-ai/maximus';
import { checkSchema } from '@arbol-ai/maximus/schemas';

import { ReminderMessageSchema, reminderStore } from '../src/reminders.ts';

const consume: ExportedHandlerQueueHandler<Env, unknown> = async (batch, env) => {
  for (const message of batch.messages) {
    const checked = checkSchema(ReminderMessageSchema, message.body);
    if (!checked.success) {
      reportUnexpected(checked.error, 'queue');
      message.ack();
      continue;
    }
    const { organizationId, reminderId } = checked.data;
    try {
      // A reminder deleted since its message was sent has nothing left to deliver.
      await reminderStore(env.REMINDER_STATE, organizationId).deliver(reminderId);
      message.ack();
    } catch (error) {
      reportUnexpected(error, 'queue');
      message.retry({ delaySeconds: 30 * 2 ** (message.attempts - 1) });
    }
  }
};

export default consume;
