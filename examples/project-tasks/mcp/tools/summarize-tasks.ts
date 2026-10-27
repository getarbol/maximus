import { defineTool, t } from '@arbol-ai/maximus';

/** The MCP tool summarize_tasks: agents only, no HTTP route. */
export default defineTool({
  description: "Summarize the organization's tasks for a weekly review: how many are open and done.",
  effect: 'read',
  output: { open: t.Integer(), done: t.Integer(), summary: t.String() },
  handler: async ({ tasks }) => {
    const all = await tasks.list();
    const done = all.filter((task) => task.done).length;
    const open = all.length - done;
    return { open, done, summary: `${open} open and ${done} done.` };
  },
});
