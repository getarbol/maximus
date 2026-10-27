import { defineHandler, t } from '@arbol-ai/maximus';

import { TaskSchema } from '#src/tasks.ts';

/** GET /api/v1/tasks, also the MCP tool list_tasks: the organization's tasks, open and done. */
export default defineHandler(
  async ({ tasks }) => {
    const organizationTasks = await tasks.list();
    return { tasks: organizationTasks };
  },
  {
    description: "List the organization's tasks, open and done.",
    output: { tasks: t.Array(TaskSchema) },
    mcp: { name: 'list_tasks' },
  }
);
