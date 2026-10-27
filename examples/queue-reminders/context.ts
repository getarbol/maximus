/**
 * What every handler receives besides its input: the caller's organization's reminders.
 */
import { defineContext } from '@arbol-ai/maximus';

import { reminderStore } from './src/reminders.ts';

export default defineContext(({ env, principal }) => ({
  reminders: reminderStore(env.REMINDER_STATE, principal.organizationId),
}));
