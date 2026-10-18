/**
 * The tasks application every resource module builds on: its error catalog, tokens and MCP configuration
 * (instructions, a guide and a skill).
 */
import { defineErrors, maximus } from '@arbol-ai/maximus';

import type { Env } from './env';
import { WEEKLY_REVIEW } from './skills';
import { tokens } from './tokens';

/** The standard failures plus the tasks service's own. */
export const errors = defineErrors({
  taskNotFound: { code: 'TASK_NOT_FOUND', status: 404, message: 'The task does not exist.' },
});

/** The one application every resource module builds on. */
export const base = maximus<Env>({
  name: 'example-tasks',
  namespace: 'tasks',
  title: 'Tasks',
  version: '1.0.0',
  origin: 'https://tasks.example.com',
  tokens,
  errors,
  rpc: { callers: [] },
  mcp: {
    instructions:
      "Tasks of the caller's organization. List tasks before changing them, and complete a finished task instead of deleting it.",
    guides: [
      {
        name: 'task-conventions',
        title: 'Task conventions',
        text: 'A task title is one short sentence in the imperative. Completing a task keeps it in the list as done; deleting removes it for everyone in the organization.',
      },
    ],
    skills: [WEEKLY_REVIEW],
    skillTool: 'read_skill',
  },
});
