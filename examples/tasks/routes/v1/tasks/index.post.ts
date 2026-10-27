import { defineHandler } from '@arbol-ai/maximus';

import { TaskSchema, TaskTitleSchema } from '#src/tasks.ts';

/** POST /api/v1/tasks: a new open task, answered with 201 Created. */
export default defineHandler(({ input, tasks }) => tasks.create(input.title), {
  description: 'Add an open task to the organization.',
  input: { title: TaskTitleSchema },
  output: TaskSchema,
  http: { successStatus: 201 },
});
