import { defineHandler, UuidSchema } from '@arbol-ai/maximus';

/** DELETE /api/v1/tasks/{taskId}: answers the empty object, whether or not the task existed. */
export default defineHandler(
  async ({ input, tasks }) => {
    await tasks.delete(input.taskId);
  },
  {
    description: 'Delete a task of the organization. Deleting a missing task changes nothing.',
    input: { taskId: UuidSchema },
  }
);
