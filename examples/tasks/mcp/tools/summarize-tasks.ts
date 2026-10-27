import { defineTool } from '@arbol-ai/maximus';

import { summarizeTasks, TaskSummarySchema } from '#src/tasks.ts';

/** The MCP tool summarize_tasks, which no HTTP route serves: how many tasks are open and how many done. */
export default defineTool(
  async ({ tasks }) => {
    const organizationTasks = await tasks.list();
    return summarizeTasks(organizationTasks);
  },
  {
    description:
      "Summarize the organization's tasks for a weekly review: how many are open and how many are done.",
    effect: 'read',
    output: TaskSummarySchema,
  }
);
