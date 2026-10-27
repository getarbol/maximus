import { defineHandler, t } from '@arbol-ai/maximus';

import { ReminderSchema } from '../../../src/reminders.ts';

/**
 * POST /api/v1/reminders, also the MCP tool schedule_reminder: stores the reminder, then queues its delivery
 * and answers 202 Accepted. Should queueing fail, the call fails and the sweep delivers the stored reminder
 * once it is overdue.
 */
export default defineHandler(
  async ({ input, principal, env, reminders }) => {
    const delaySeconds = input.delaySeconds ?? 0;
    const reminder = await reminders.create(input.text, delaySeconds);
    await env.REMINDERS.send(
      { organizationId: principal.organizationId, reminderId: reminder.reminderId },
      { delaySeconds }
    );
    return reminder;
  },
  {
    description:
      'Schedule a reminder for the organization, delivered now or after a delay of up to twelve hours.',
    input: {
      text: t.String({ minLength: 1, maxLength: 500 }),
      delaySeconds: t.Optional(t.Integer({ minimum: 0, maximum: 43_200 })),
    },
    output: ReminderSchema,
    http: { successStatus: 202 },
    mcp: { name: 'schedule_reminder' },
  }
);
