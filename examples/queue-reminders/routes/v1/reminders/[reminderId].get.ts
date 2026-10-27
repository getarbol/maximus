import { defineHandler, UuidSchema } from '@arbol-ai/maximus';

import { ReminderSchema } from '#src/reminders.ts';

/** GET /api/v1/reminders/{reminderId}, also the MCP tool get_reminder: one reminder, and its status. */
export default defineHandler(
  async ({ input, reminders, fail }) => {
    const reminder = await reminders.find(input.reminderId);
    if (!reminder) {
      return fail('REMINDER_NOT_FOUND');
    }
    return reminder;
  },
  {
    description:
      'Read one reminder of the organization: its text, when it is due and whether it was delivered.',
    input: { reminderId: UuidSchema },
    output: ReminderSchema,
    failures: ['REMINDER_NOT_FOUND'],
    mcp: { name: 'get_reminder' },
  }
);
