/**
 * One organization's tasks in Workers KV, every stored value read through its schema.
 */
import { readSchema } from '@arbol-ai/maximus/schemas';

import type { TaskStore } from '../../env';
import { TaskSchema } from './schemas';
import type { Task } from './schemas';

/** One organization's tasks. Every key carries the verified organization; none comes from input. */
export interface Tasks {
  list: (status?: Task['status']) => Promise<Task[]>;
  get: (taskId: string) => Promise<Task | null>;
  save: (task: Task) => Promise<void>;
  remove: (taskId: string) => Promise<void>;
}

/** The tasks of one organization, every key under its own prefix. */
export function organizationTasks(store: TaskStore, organizationId: string): Tasks {
  const prefix = `tasks/${organizationId}/`;
  /** Stored values are untrusted until read through their schema. */
  async function read(key: string): Promise<Task | null> {
    const stored = await store.get(key);
    return stored === null ? null : readSchema(TaskSchema, JSON.parse(stored));
  }
  return {
    async list(status) {
      const { keys } = await store.list({ prefix, limit: 100 });
      const tasks = await Promise.all(keys.map(({ name }) => read(name)));
      return tasks.filter(
        (task): task is Task => task !== null && (status === undefined || task.status === status)
      );
    },
    get: (taskId) => read(`${prefix}${taskId}`),
    save: (task) => store.put(`${prefix}${task.taskId}`, JSON.stringify(task)),
    remove: (taskId) => store.delete(`${prefix}${taskId}`),
  };
}

/** A new open task with a fresh id. */
export function newTask(title: string): Task {
  return {
    taskId: crypto.randomUUID(),
    title,
    status: 'open',
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
}

/** The task as done. Completing a done task changes nothing, so the operation is idempotent. */
export function completed(task: Task): Task {
  return task.status === 'done' ? task : { ...task, status: 'done', completedAt: new Date().toISOString() };
}
