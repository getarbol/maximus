import { defineHandler, UuidSchema } from '@arbol-ai/maximus';

import { ReminderSchema } from '../../../src/reminders.ts';

/** GET /api/v1/reminders/{reminderId}, also the MCP tool get_reminder: the reminder and whether it was delivered. */
export default defineHandler(
  async ({ input, reminders, fail }) => (await reminders.get(input.reminderId)) ?? fail('REMINDER_NOT_FOUND'),
  {
    description:
      'Read one reminder of the organization: its text, when it is due and whether it was delivered.',
    input: { reminderId: UuidSchema },
    output: ReminderSchema,
    failures: ['REMINDER_NOT_FOUND'],
    mcp: { name: 'get_reminder' },
  }
);
