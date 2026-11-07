/**
 * The task store and its executor: one SQLite Durable Object per task keeps it and runs it from its alarm, at
 * once and at most once, so no task waits for another. The input is never stored: it stays in the object's
 * memory until the alarm starts the task. A task found started but still working, after the object restarted
 * mid-run, settles as OUTCOME_UNKNOWN and never runs again; one whose input went with a restart before it
 * started settles as INTERNAL_ERROR, never having run. The object deletes everything once the task's TTL has
 * passed since its call.
 */
import { DurableObject } from 'cloudflare:workers';

import { recordCapture } from '../capture.ts';
import { executeOperation } from '../execution.ts';
import type { ExecutionCall } from '../execution.ts';
import { err, standardErrors } from '../index.ts';
import type { Failure, Principal, Result } from '../index.ts';
import { delay } from '../internal/delay.ts';
import type { AppManifest, OperationShape } from '../internals.ts';
import type { TaskRecord, TaskStore } from '../tasks.ts';
import { recordExecution } from '../telemetry.ts';

/** Where the object keeps its task. */
const KEY = 'task';
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
    /** The task's input, in memory alone, until the task starts. */
    #input?: { value: unknown };
    /** Answers the call waiting for the task to settle. */
    #settled?: () => void;
    /** Whether this instance is running the task: a task found started otherwise was interrupted. */
    #running = false;

    /** Keeps the task, has the alarm start it at once, and answers it once it settles or `waitMs` passes. */
    async run(task: TaskRecord, input: unknown, waitMs: number): Promise<TaskRecord> {
      // oxlint-disable-next-line promise/avoid-new -- The alarm settles the task: this is where the call hears of it.
      const settled = new Promise<void>((resolve) => {
        this.#settled = resolve;
      });
      this.#input = { value: input };
      await this.ctx.storage.put(KEY, task);
      await this.ctx.storage.setAlarm(Date.now());
      await Promise.race([settled, delay(waitMs)]);
      return (await this.ctx.storage.get<TaskRecord>(KEY)) ?? task;
    }

    /** The task, when `principal` started it and it has not expired. */
    async get(taskId: string, principal: Principal): Promise<TaskRecord | undefined> {
      const task = await this.ctx.storage.get<TaskRecord>(KEY);
      if (!task || task.taskId !== taskId || task.createdAt + task.ttlMs <= Date.now()) {
        return undefined;
      }
      return owns(task, principal) ? task : undefined;
    }

    /** Cancels a task `principal` started that has not started running; one that has runs to its end. */
    async cancel(taskId: string, principal: Principal): Promise<TaskRecord | undefined> {
      const task = await this.get(taskId, principal);
      if (task?.status !== 'working' || task.started) {
        return task;
      }
      this.#input = undefined;
      const cancelled = { ...task, status: 'cancelled' as const, lastUpdatedAt: Date.now() };
      await this.ctx.storage.put(KEY, cancelled);
      return cancelled;
    }

    /** Runs the task, or settles one a restart interrupted, then wakes once more to delete it when it expires. */
    async alarm(): Promise<void> {
      const input = this.#input;
      this.#input = undefined;
      const task = await this.ctx.storage.get<TaskRecord>(KEY);
      if (!task || task.createdAt + task.ttlMs <= Date.now()) {
        await this.ctx.storage.deleteAll();
        return;
      }
      if (task.status === 'working' && !this.#running) {
        if (task.started) {
          // A restart interrupted it: it may have done its work, so it never runs again.
          await this.#settle(task, err(standardErrors.outcomeUnknown.create()));
        } else if (input) {
          await this.#execute(task, input.value);
        } else {
          // Its input went with a restart before it started: it never ran.
          await this.#settle(task, err(standardErrors.internal.create()));
        }
      }
      await this.ctx.storage.setAlarm(task.createdAt + task.ttlMs);
    }

    /** Marks the task started, then runs its operation as its caller and keeps the result. */
    async #execute(task: TaskRecord, input: unknown): Promise<void> {
      const pending: Promise<unknown>[] = [];
      const background = {
        waitUntil: (promise: Promise<unknown>) => {
          pending.push(promise);
        },
      };
      this.#running = true;
      try {
        await this.ctx.storage.put(KEY, { ...task, started: true });
        const operation = manifest.operations[task.operation];
        const surface = task.authority?.surface ?? 'http';
        const call: ExecutionCall = { taskId: task.taskId };
        const started = performance.now();
        const result = operation
          ? await executeOperation(
              manifest,
              operation,
              this.env,
              task.principal,
              input,
              task.authority,
              background,
              undefined,
              call
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
          call,
        });
        await this.#settle(task, result);
      } finally {
        // A run that could not keep its result leaves its task started: the next alarm settles it.
        this.#running = false;
      }
      await Promise.allSettled(pending);
    }

    /** Keeps how the task ended and answers the call waiting for it. */
    async #settle(task: TaskRecord, result: Result<unknown, Failure>): Promise<void> {
      const status = result.ok ? ('completed' as const) : ('failed' as const);
      await this.ctx.storage.put(KEY, {
        ...task,
        started: true,
        status,
        result,
        lastUpdatedAt: Date.now(),
      });
      this.#settled?.();
    }
  };
}
