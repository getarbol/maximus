import { defineHandler, UuidSchema } from '@arbol-ai/maximus';

import { TaskSchema } from '../../../src/tasks.ts';

/** GET /api/v1/tasks/{taskId}. */
export default defineHandler(
  async ({ input, tasks, fail }) => (await tasks.get(input.taskId)) ?? fail('TASK_NOT_FOUND'),
  {
    input: { taskId: UuidSchema },
    output: TaskSchema,
    failures: ['TASK_NOT_FOUND'],
  }
);
