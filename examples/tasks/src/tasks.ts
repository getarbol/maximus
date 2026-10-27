/**
 * Tasks in Workers KV. Every key starts with the verified organization, so one tenant never reads
 * another's tasks, and stored values are read through their schema.
 */
import { t, UuidSchema } from '@arbol-ai/maximus';
import type { Static } from '@arbol-ai/maximus';
import { readSchema } from '@arbol-ai/maximus/schemas';

/** A task's title: what is to be done, in at most 200 characters. */
export const TaskTitleSchema = t.String({ minLength: 1, maxLength: 200 });

/** A task as it is stored and answered. */
export const TaskSchema = t.Object(
  {
    taskId: UuidSchema,
    title: TaskTitleSchema,
    done: t.Boolean(),
    createdAt: t.String({ format: 'date-time' }),
  },
  { $id: 'Task', additionalProperties: false }
);
/** A task. */
export type Task = Static<typeof TaskSchema>;

/** How many tasks are open and how many are done, and a sentence that says so. */
export const TaskSummarySchema = t.Object(
  { open: t.Integer(), done: t.Integer(), summary: t.String() },
  { additionalProperties: false }
);
/** A summary of tasks. */
export type TaskSummary = Static<typeof TaskSummarySchema>;

/** The most tasks a list answers. */
const MAX_LISTED_TASKS = 100;

/** The tasks of one organization, stored under keys that start with its id. */
export function taskStore(namespace: KVNamespace, organizationId: string) {
  const prefix = `tasks/${organizationId}/`;

  /** The key a task of the organization is stored under. */
  function taskKey(taskId: string): string {
    return `${prefix}${taskId}`;
  }

  /** The task with this id, or undefined when the organization has none. */
  async function find(taskId: string): Promise<Task | undefined> {
    const stored = await namespace.get(taskKey(taskId));
    if (stored === null) {
      return undefined;
    }
    return readSchema(TaskSchema, JSON.parse(stored));
  }

  /** Stores the task and answers it. */
  async function save(task: Task): Promise<Task> {
    await namespace.put(taskKey(task.taskId), JSON.stringify(task));
    return task;
  }

  return {
    find,

    /** The organization's tasks, open and done, at most a hundred of them. */
    async list(): Promise<Task[]> {
      const { keys } = await namespace.list({ prefix, limit: MAX_LISTED_TASKS });
      const tasks = await Promise.all(keys.map((key) => find(key.name.slice(prefix.length))));
      // A task deleted since its key was listed is left out.
      return tasks.filter((task) => task !== undefined);
    },

    /** Stores a new open task with this title and answers it. */
    create(title: string): Promise<Task> {
      return save({ taskId: crypto.randomUUID(), title, done: false, createdAt: new Date().toISOString() });
    },

    /**
     * Marks the task done and answers it, or undefined when the organization has none with this id.
     * Completing a done task changes nothing.
     */
    async complete(taskId: string): Promise<Task | undefined> {
      const task = await find(taskId);
      if (!task) {
        return undefined;
      }
      if (task.done) {
        return task;
      }
      return save({ ...task, done: true });
    },

    /** Deletes the task; deleting a missing one changes nothing. */
    async delete(taskId: string): Promise<void> {
      await namespace.delete(taskKey(taskId));
    },
  };
}

/** How many of the tasks are open and how many are done, and a sentence that says so. */
export function summarizeTasks(tasks: readonly Task[]): TaskSummary {
  const done = tasks.filter((task) => task.done).length;
  const open = tasks.length - done;
  return { open, done, summary: `${open} open and ${done} done.` };
}
