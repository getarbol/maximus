/**
 * What every handler receives besides its input: the reminders of the caller's organization.
 */
import { defineContext } from '@arbol-ai/maximus';

import { reminderStore } from '#src/reminders.ts';

export default defineContext(({ env, principal }) => ({
  reminders: reminderStore(env.REMINDER_STATE, env.REMINDERS, principal.organizationId),
}));
