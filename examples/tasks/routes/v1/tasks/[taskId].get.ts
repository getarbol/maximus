import { defineHandler, UuidSchema } from '@arbol-ai/maximus';

import { TaskSchema } from '#src/tasks.ts';

/** GET /api/v1/tasks/{taskId}: one task of the caller's organization. */
export default defineHandler(
  async ({ input, tasks, fail }) => {
    const task = await tasks.find(input.taskId);
    if (!task) {
      return fail('TASK_NOT_FOUND');
    }
    return task;
  },
  {
    description: 'Read one task of the organization by its id.',
    input: { taskId: UuidSchema },
    output: TaskSchema,
    failures: ['TASK_NOT_FOUND'],
  }
);
