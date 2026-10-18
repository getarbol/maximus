/**
 * An Agent Skill the tasks service serves over MCP.
 */
import type { McpSkill } from '@arbol-ai/maximus';

/** Static guidance served over MCP; it holds no tenant data and grants no tool or scope. */
export const WEEKLY_REVIEW: McpSkill = {
  name: 'weekly-review',
  description: 'Review the open tasks with the user and close the ones that are already done.',
  text: [
    '# Weekly review',
    '',
    '1. Call `list_tasks` with `status: "open"`.',
    '2. Read the titles to the user and ask which ones are finished.',
    '3. Call `complete_task` for each finished task. Never delete a task the user only wants to close.',
    '4. Summarize what is still open.',
  ].join('\n'),
};
