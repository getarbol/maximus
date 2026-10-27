import { defineHandler, UuidSchema } from '@arbol-ai/maximus';

import { TaskSchema } from '#src/tasks.ts';

/** POST /api/v1/tasks/{taskId}/complete, also the MCP tool complete_task: the task, marked done. */
export default defineHandler(
  async ({ input, tasks, fail }) => {
    const task = await tasks.complete(input.taskId);
    if (!task) {
      return fail('TASK_NOT_FOUND');
    }
    return task;
  },
  {
    description: 'Mark a task as done. Completing a done task changes nothing.',
    input: { taskId: UuidSchema },
    output: TaskSchema,
    failures: ['TASK_NOT_FOUND'],
    mcp: { name: 'complete_task', idempotent: true },
  }
);
