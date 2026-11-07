/**
 * The task store and its executor: one SQLite Durable Object per organization keeps its tasks and runs each
 * from its alarm, at most once. A task found started but still working, when the object restarted mid-run,
 * settles as OUTCOME_UNKNOWN and never runs again. A task's input is kept until it runs, and the task an hour.
 */
import { DurableObject } from 'cloudflare:workers';

import { recordCapture } from '../capture.ts';
import { executeOperation } from '../execution.ts';
import { err, standardErrors } from '../index.ts';
import type { Failure, Principal, Result } from '../index.ts';
import { delay } from '../internal/delay.ts';
import type { AppManifest, OperationShape } from '../internals.ts';
import { TASK_TTL_MS } from '../tasks.ts';
import type { TaskRecord, TaskStore } from '../tasks.ts';
import { recordExecution } from '../telemetry.ts';

/** Where a task is stored. */
const key = (taskId: string) => `task:${taskId}`;
/** Whether `principal` started the task: the same organization and the same actor. */
const owns = (task: TaskRecord, principal: Principal) =>
  task.principal.organizationId === principal.organizationId &&
  task.principal.actorId === principal.actorId &&
  task.principal.actorKind === principal.actorKind;

/** The task store class of an application, which a Worker exports for its `MAXIMUS_TASKS` binding. */
export function tasksObject<E, C, O extends Record<string, OperationShape>>(
  manifest: AppManifest<E, C, O>
): new (state: DurableObject['ctx'], env: E) => DurableObject<E> & TaskStore {
  return class MaximusTasks extends DurableObject<E> implements TaskStore {
    /** The calls waiting for a task to settle, by its id. */
    readonly #waiting = new Map<string, () => void>();
    /** The tasks this instance is running: any other task found started was interrupted. */
    readonly #running = new Set<string>();

    /** Keeps a task, has the alarm run it, and answers it once it settles or `waitMs` passes. */
    async run(task: TaskRecord, waitMs: number): Promise<TaskRecord> {
      await this.ctx.storage.put(key(task.taskId), task);
      await this.ctx.storage.setAlarm(Date.now());
      // oxlint-disable-next-line promise/avoid-new -- The alarm settles the task: this is where the call hears of it.
      const settled = new Promise<void>((resolve) => {
        this.#waiting.set(task.taskId, resolve);
      });
      await Promise.race([settled, delay(waitMs)]);
      this.#waiting.delete(task.taskId);
      return (await this.ctx.storage.get<TaskRecord>(key(task.taskId))) ?? task;
    }

    /** The task, when `principal` started it and it has not expired. */
    async get(taskId: string, principal: Principal): Promise<TaskRecord | undefined> {
      const task = await this.ctx.storage.get<TaskRecord>(key(taskId));
      return task && owns(task, principal) ? task : undefined;
    }

    /** Cancels a task `principal` started that has not started running; one that has runs to its end. */
    async cancel(taskId: string, principal: Principal): Promise<TaskRecord | undefined> {
      const task = await this.get(taskId, principal);
      if (task?.status !== 'working' || task.started) {
        return task;
      }
      const cancelled = { ...task, status: 'cancelled' as const, lastUpdatedAt: Date.now() };
      await this.ctx.storage.put(key(taskId), cancelled);
      return cancelled;
    }

    /** Deletes the expired tasks and runs the waiting ones, then wakes again for what is left. */
    async alarm(): Promise<void> {
      const now = Date.now();
      const runs: Promise<void>[] = [];
      for (const [name, task] of await this.ctx.storage.list<TaskRecord>({ prefix: 'task:' })) {
        if (task.createdAt + TASK_TTL_MS <= now) {
          await this.ctx.storage.delete(name);
        } else if (task.status === 'working' && !this.#running.has(task.taskId)) {
          // A task found started is one a restart interrupted: it may have done its work, so it never runs again.
          runs.push(
            task.started
              ? this.#settle(task, err(standardErrors.outcomeUnknown.create()))
              : this.#execute(task)
          );
        }
      }
      await Promise.all(runs);
      const kept = await this.ctx.storage.list<TaskRecord>({ prefix: 'task:' });
      const left = [...kept.values()];
      if (left.length) {
        // A task kept while these ran runs at once; otherwise the next wake deletes the oldest task.
        const waiting = left.some((task) => task.status === 'working');
        await this.ctx.storage.setAlarm(
          waiting ? Date.now() : Math.min(...left.map((task) => task.createdAt + TASK_TTL_MS))
        );
      }
    }

    /** Marks the task started, then runs its operation as its caller and keeps the result. */
    async #execute(task: TaskRecord): Promise<void> {
      this.#running.add(task.taskId);
      // The input stays in memory from here on: storage keeps it only until the task starts.
      await this.ctx.storage.put(key(task.taskId), { ...task, input: null, started: true });
      const operation = manifest.operations[task.operation];
      const surface = task.authority?.surface ?? 'http';
      const pending: Promise<unknown>[] = [];
      const background = {
        waitUntil: (promise: Promise<unknown>) => {
          pending.push(promise);
        },
      };
      const started = performance.now();
      const result = operation
        ? await executeOperation(
            manifest,
            operation,
            this.env,
            task.principal,
            task.input,
            task.authority,
            background
          )
        : err(standardErrors.notFound.create());
      recordExecution(manifest, this.env, background, {
        principal: task.principal,
        operation: task.operation,
        surface,
        started,
        result,
      });
      recordCapture(manifest, this.env, background, {
        operation: task.operation,
        surface,
        requestId: task.principal.requestId,
        principal: task.principal,
        requestStarted: started,
        executionStarted: started,
        result,
        call: {},
      });
      await this.#settle(task, result);
      this.#running.delete(task.taskId);
      await Promise.allSettled(pending);
    }

    /** Keeps how a task ended and answers the call waiting for it. */
    async #settle(task: TaskRecord, result: Result<unknown, Failure>): Promise<void> {
      const status = result.ok ? ('completed' as const) : ('failed' as const);
      await this.ctx.storage.put(key(task.taskId), {
        ...task,
        input: null,
        started: true,
        status,
        result,
        lastUpdatedAt: Date.now(),
      });
      this.#waiting.get(task.taskId)?.();
    }
  };
}
