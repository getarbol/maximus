import { defineHandler, t } from '@arbol-ai/maximus';

import { ReminderSchema, ReminderTextSchema } from '#src/reminders.ts';

/**
 * POST /api/v1/reminders, also the MCP tool schedule_reminder: stores the reminder, then queues its delivery
 * and answers 202 Accepted. Should queueing fail, the call fails and the sweep delivers the stored reminder
 * once it is overdue.
 */
export default defineHandler(({ input, reminders }) => reminders.schedule(input.text, input.delaySeconds), {
  description:
    'Schedule a reminder for the organization, delivered now or after a delay of up to twelve hours.',
  input: {
    text: ReminderTextSchema,
    delaySeconds: t.Optional(t.Integer({ minimum: 0, maximum: 43_200 })),
  },
  output: ReminderSchema,
  http: { successStatus: 202 },
  mcp: { name: 'schedule_reminder' },
});
