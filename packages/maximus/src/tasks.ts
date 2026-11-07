/**
 * Tasks for the operations that declare `task`: a call that outlasts a short wait answers a task, as MCP Tasks
 * (`io.modelcontextprotocol/tasks`) and RFC 7240's `Prefer: respond-async` define it, and the work goes on in
 * the application's task store, the `MAXIMUS_TASKS` Durable Object binding (`createWorker`'s `tasks`), one
 * object per task. Without that binding every call runs as before. A task belongs to the caller that started
 * it, runs at most once and is kept for its `ttlMs`: an hour, unless its operation declares another.
 */
import { Type as t } from 'typebox';
import type { Static } from 'typebox';

import { FailureSchema, standardErrors } from './errors.ts';
import type { Failure } from './errors.ts';
import { literalUnion } from './input-schemas.ts';
import { Value } from './internal/value.ts';
import { composeOperations, operationScopes } from './manifest.ts';
import type { Invocation, InvocationAuthority, OperationShape } from './manifest.ts';
import type { Principal } from './principal.ts';
import { err, ok } from './result.ts';
import type { Result } from './result.ts';
import { UuidSchema } from './schemas.ts';

/** How long a call waits for its task to finish before it answers the task instead. */
export const TASK_WAIT_MS = 1000;
/** How long a task and its result are kept after the call, unless its operation declares `task: { ttlMs }`. */
export const TASK_TTL_MS = 3_600_000;
/** The longest an operation may keep its tasks: a day. */
export const MAX_TASK_TTL_MS = 86_400_000;
/** How often a client should ask for a task that is still working. */
export const TASK_POLL_MS = 2000;

/** A task as the store keeps it: the call it runs, as whom, and how it ended; never its input. */
export interface TaskRecord {
  /** The application's namespace, a dot, and a random UUID, so a gateway can tell whose task it is. */
  taskId: string;
  operation: string;
  principal: Principal;
  /** The verified authority of the call, without its bearer token, which is never stored. */
  authority?: Omit<InvocationAuthority, 'token'>;
  status: 'working' | 'completed' | 'failed' | 'cancelled';
  /** Set before the work runs, so a task found started but still working is never run again. */
  started: boolean;
  result?: Result<unknown, Failure>;
  createdAt: number;
  lastUpdatedAt: number;
  /** How long after `createdAt` the task and its result are kept. */
  ttlMs: number;
}
/** The task store's methods, as the Worker calls the Durable Object that keeps one task. */
export interface TaskStore {
  /** Keeps the task, runs it with `input`, which stays in memory, and answers it once settled or after `waitMs`. */
  run: (task: TaskRecord, input: unknown, waitMs: number) => Promise<TaskRecord>;
  get: (taskId: string, principal: Principal) => Promise<TaskRecord | undefined>;
  cancel: (taskId: string, principal: Principal) => Promise<TaskRecord | undefined>;
}
/** One caller's tasks: start one of the application's operations as a task, read one, or cancel one. */
export interface TaskAccess {
  start: (operation: string, input: unknown) => Promise<TaskRecord>;
  get: (taskId: string) => Promise<TaskRecord | undefined>;
  cancel: (taskId: string) => Promise<TaskRecord | undefined>;
}

/** How long an operation keeps its tasks: its `task.ttlMs`, or an hour. */
export function taskTtl(operation: Pick<OperationShape, 'task'> | undefined): number {
  return typeof operation?.task === 'object' ? operation.task.ttlMs : TASK_TTL_MS;
}

/**
 * The caller's tasks in the store `env` binds as `MAXIMUS_TASKS`, or none without it. Each task has its own
 * object, named by its id, so no task waits for another; an id this application never issues names none.
 */
export function taskAccess(
  application: { namespace: string; operations: Record<string, OperationShape> },
  env: unknown,
  principal: Principal,
  authority?: InvocationAuthority
): TaskAccess | undefined {
  const binding = (
    env as { MAXIMUS_TASKS?: { idFromName: (name: string) => unknown; get: (id: unknown) => TaskStore } }
  )?.MAXIMUS_TASKS;
  if (!binding) {
    return undefined;
  }
  const prefix = `${application.namespace}.`;
  const store = (taskId: string) => binding.get(binding.idFromName(taskId));
  /** Whether the id is one this application issues: its namespace, a dot and a UUID. */
  const issued = (taskId: string) =>
    taskId.startsWith(prefix) && Value.Check(UuidSchema, taskId.slice(prefix.length));
  const kept = authority && {
    surface: authority.surface,
    scopes: authority.scopes,
    client: authority.client,
  };
  return {
    start: (operation, input) => {
      const now = Date.now();
      const taskId = `${prefix}${crypto.randomUUID()}`;
      const task = { taskId, operation, principal, status: 'working' as const, started: false };
      return store(taskId).run(
        {
          ...task,
          ...(kept ? { authority: kept } : {}),
          createdAt: now,
          lastUpdatedAt: now,
          ttlMs: taskTtl(application.operations[operation]),
        },
        input,
        TASK_WAIT_MS
      );
    },
    get: (taskId) => (issued(taskId) ? store(taskId).get(taskId, principal) : Promise.resolve(undefined)),
    cancel: (taskId) =>
      issued(taskId) ? store(taskId).cancel(taskId, principal) : Promise.resolve(undefined),
  };
}

/** A task as REST answers it: its state, then the operation's value or failure once it has one. */
export const TaskSchema = t.Object(
  {
    taskId: t.String(),
    status: literalUnion(['working', 'completed', 'failed', 'cancelled']),
    createdAt: t.String({ format: 'date-time' }),
    lastUpdatedAt: t.String({ format: 'date-time' }),
    ttlMs: t.Integer(),
    pollIntervalMs: t.Integer(),
    result: t.Optional(t.Unknown({ description: "The operation's value, once completed." })),
    error: t.Optional(t.With(FailureSchema, { description: "The operation's failure, once failed." })),
  },
  {
    $id: 'OperationTask',
    additionalProperties: false,
    description: 'A call that goes on after it was answered.',
  }
);
/** A task as REST answers it. */
export function taskView(task: TaskRecord): Static<typeof TaskSchema> {
  return {
    taskId: task.taskId,
    status: task.status,
    createdAt: new Date(task.createdAt).toISOString(),
    lastUpdatedAt: new Date(task.lastUpdatedAt).toISOString(),
    ttlMs: task.ttlMs,
    pollIntervalMs: TASK_POLL_MS,
    ...(task.result?.ok === true ? { result: task.result.value } : {}),
    ...(task.result?.ok === false ? { error: task.result.error } : {}),
  };
}

/**
 * `getOperationTask`, `GET /v1/operation-tasks/{taskId}`, which reads a task the caller started, and
 * `cancelOperationTask`, `POST /v1/operation-tasks/{taskId}/cancel`, which cancels one that has not started
 * running: names and paths no resource of a service uses. Either admits any scope of the task operations;
 * someone else's task, or an unknown or expired one, is `INVALID_INPUT` at `/taskId`, their only failure
 * besides admission's.
 */
function taskOperations(
  scope: readonly [string, ...string[]],
  application: { namespace: string; operations: Record<string, OperationShape> }
) {
  const answer =
    (method: 'get' | 'cancel') =>
    async ({ env, principal }: Invocation<unknown>, { taskId }: { taskId: string }) => {
      const task = await taskAccess(application, env, principal)?.[method](taskId);
      // As MCP answers an unknown task: invalid params, whether it never existed, expired or is another's.
      const issues = [{ path: '/taskId', message: 'must name a task you started' }];
      return task ? ok(taskView(task)) : err(standardErrors.invalidInput.create({ issues }));
    };
  const shared = {
    scope,
    failures: [],
    input: t.Object({ taskId: t.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }),
    output: TaskSchema,
    // The handler reads the store as the verified caller, without the application's own context.
    pipeline: { context: (invocation: never) => Promise.resolve(ok(invocation)), middleware: [] },
  };
  return {
    getOperationTask: {
      ...shared,
      title: 'Read a task',
      description: "Read a task you started: whether it still works, then the operation's value or failure.",
      effect: 'read' as const,
      http: { method: 'GET' as const, path: '/v1/operation-tasks/{taskId}' },
      execute: answer('get') as OperationShape['execute'],
    },
    cancelOperationTask: {
      ...shared,
      title: 'Cancel a task',
      description: 'Cancel a task you started that has not started running; one that has runs to its end.',
      effect: 'write' as const,
      http: { method: 'POST' as const, path: '/v1/operation-tasks/{taskId}/cancel' },
      execute: answer('cancel') as OperationShape['execute'],
    },
  };
}
/** The operations `.build()` adds once an operation declares `task`: `getOperationTask` and `cancelOperationTask`. */
export type TaskOperations = ReturnType<typeof taskOperations>;
/** An application's operations, with the task operations when one of them declares `task`. */
export type WithTaskOperations<Ops> = true extends {
  [K in keyof Ops]: Ops[K] extends { task: NonNullable<OperationShape['task']> } ? true : false;
}[keyof Ops]
  ? Ops & TaskOperations
  : Ops;

/** The application's operations and, when one of them declares `task`, the task operations. */
export function withTaskOperations<Ops extends Record<string, OperationShape>>(
  operations: Ops,
  namespace: string
): WithTaskOperations<Ops> {
  const [first, ...rest] = new Set(
    Object.values(operations).flatMap((op) => (op.task ? operationScopes(op) : []))
  );
  if (first === undefined) {
    return operations as WithTaskOperations<Ops>;
  }
  return composeOperations(
    operations,
    taskOperations([first, ...rest], { namespace, operations })
  ) as WithTaskOperations<Ops>;
}
