/**
 * The reminders service's own failures, registered for every handler: `fail` and `failures` take these codes.
 */
import { defineErrors } from '@arbol-ai/maximus';

export default defineErrors({
  reminderNotFound: { code: 'REMINDER_NOT_FOUND', status: 404, message: 'The reminder does not exist.' },
});
