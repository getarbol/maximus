import { defineHandler, t } from '@arbol-ai/maximus';

import { TaskSchema } from '../../../src/tasks.ts';

/** POST /api/v1/tasks: a new open task. */
export default defineHandler({
  input: { title: t.String({ minLength: 1, maxLength: 200 }) },
  output: TaskSchema,
  http: { successStatus: 201 },
  handler: ({ input, tasks }) =>
    tasks.put({
      taskId: crypto.randomUUID(),
      title: input.title,
      done: false,
      createdAt: new Date().toISOString(),
    }),
});
