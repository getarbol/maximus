/**
 * What every handler receives besides its input: the caller's organization's tasks.
 */
import { defineContext } from '@arbol-ai/maximus';

import { taskStore } from './src/tasks.ts';

export default defineContext(({ env, principal }) => ({
  tasks: taskStore(env.TASKS, principal.organizationId),
}));
