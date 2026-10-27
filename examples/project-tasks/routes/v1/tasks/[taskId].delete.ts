import { defineHandler, UuidSchema } from '@arbol-ai/maximus';

/** DELETE /api/v1/tasks/{taskId}: deleting a missing task changes nothing. */
export default defineHandler(
  async ({ input, tasks }) => {
    await tasks.delete(input.taskId);
  },
  { input: { taskId: UuidSchema } }
);
