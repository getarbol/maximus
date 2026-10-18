/**
 * The tasks resource: its operations over HTTP and MCP, with the organization's tasks prepared once by
 * `.derive()`.
 */
import { err, ok } from '@arbol-ai/maximus';

import { base, errors } from '../../application';
import {
  CreateTaskInputSchema,
  DeletedTaskSchema,
  ListTasksInputSchema,
  ListTasksOutputSchema,
  TaskReferenceSchema,
  TaskSchema,
} from './schemas';
import { completed, newTask, organizationTasks } from './tasks';

/** Reading tasks takes either scope, so a caller that may change tasks may also read them. */
const READ = ['tasks:tasks:read', 'tasks:tasks:write'] as const;
/** Creating, completing and deleting tasks. */
const WRITE = 'tasks:tasks:write';

/** Every task operation receives its organization's tasks, prepared once after admission. */
const scoped = base.derive(async ({ env, principal }) =>
  ok({ tasks: organizationTasks(env.TASKS, principal.organizationId) })
);

/** The tasks resource module: list, create, complete and delete, each over HTTP and as an MCP tool. */
export const tasks = scoped
  .operation(
    'listTasks',
    {
      scope: READ,
      effect: 'read',
      group: 'Tasks',
      title: 'List tasks',
      description: "List the organization's tasks, optionally only the open or the done ones.",
      input: ListTasksInputSchema,
      output: ListTasksOutputSchema,
      http: { method: 'GET', path: '/v1/tasks' },
      mcp: { name: 'list_tasks', idempotent: true },
    },
    async (context, input) => ok({ tasks: await context.tasks.list(input.status) })
  )
  .operation(
    'createTask',
    {
      scope: WRITE,
      effect: 'write',
      group: 'Tasks',
      title: 'Create a task',
      description: 'Create an open task. Each call creates another task, so call it once per task.',
      input: CreateTaskInputSchema,
      output: TaskSchema,
      http: { method: 'POST', path: '/v1/tasks', successStatus: 201 },
      mcp: { name: 'create_task', idempotent: false, openWorld: false },
    },
    async (context, input) => {
      const task = newTask(input.title);
      await context.tasks.save(task);
      return ok(task);
    }
  )
  .operation(
    'completeTask',
    {
      scope: WRITE,
      effect: 'write',
      group: 'Tasks',
      title: 'Complete a task',
      description: 'Mark a task as done. Completing a done task changes nothing.',
      input: TaskReferenceSchema,
      output: TaskSchema,
      http: { method: 'POST', path: '/v1/tasks/{taskId}/complete' },
      mcp: { name: 'complete_task', idempotent: true, openWorld: false },
    },
    async (context, input) => {
      const task = await context.tasks.get(input.taskId);
      if (!task) {
        return err(errors.taskNotFound.create());
      }
      const done = completed(task);
      await context.tasks.save(done);
      return ok(done);
    }
  )
  .operation(
    'deleteTask',
    {
      scope: WRITE,
      effect: 'delete',
      group: 'Tasks',
      title: 'Delete a task',
      description: 'Remove a task for everyone in the organization. Prefer completing a finished task.',
      input: TaskReferenceSchema,
      output: DeletedTaskSchema,
      http: { method: 'DELETE', path: '/v1/tasks/{taskId}' },
      mcp: { name: 'delete_task', idempotent: true, openWorld: false },
    },
    async (context, input) => {
      if (!(await context.tasks.get(input.taskId))) {
        return err(errors.taskNotFound.create());
      }
      await context.tasks.remove(input.taskId);
      return ok({ taskId: input.taskId, deleted: true as const });
    }
  );
