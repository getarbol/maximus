/**
 * Tasks in Workers KV. Every key starts with the verified organization, so one tenant never reads
 * another's tasks, and stored values are read through their schema.
 */
import { t, UuidSchema } from '@arbol-ai/maximus';
import type { Static } from '@arbol-ai/maximus';
import { readSchema } from '@arbol-ai/maximus/schemas';

/** A task as it is stored and answered. */
export const TaskSchema = t.Object(
  {
    taskId: UuidSchema,
    title: t.String({ minLength: 1, maxLength: 200 }),
    done: t.Boolean(),
    createdAt: t.String({ format: 'date-time' }),
  },
  { $id: 'Task', additionalProperties: false }
);
/** A task. */
export type Task = Static<typeof TaskSchema>;

/** The organization's tasks. */
export function taskStore(store: KVNamespace, organizationId: string) {
  const prefix = `tasks/${organizationId}/`;
  /** The task, or null when the organization has none with this id. */
  const get = async (taskId: string): Promise<Task | null> => {
    const stored = await store.get(`${prefix}${taskId}`);
    return stored === null ? null : readSchema(TaskSchema, JSON.parse(stored));
  };
  return {
    get,
    /** Stores the task and answers it. */
    async put(task: Task): Promise<Task> {
      await store.put(`${prefix}${task.taskId}`, JSON.stringify(task));
      return task;
    },
    /** The organization's first hundred tasks. */
    async list(): Promise<Task[]> {
      const { keys } = await store.list({ prefix, limit: 100 });
      const tasks = await Promise.all(keys.map(({ name }) => get(name.slice(prefix.length))));
      return tasks.filter((task) => task !== null);
    },
    /** Removes the task; removing a missing one changes nothing. */
    async delete(taskId: string): Promise<void> {
      await store.delete(`${prefix}${taskId}`);
    },
  };
}
