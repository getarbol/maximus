/**
 * Tasks for the operations that declare `task: true`: a call that outlasts a short wait answers a task, as MCP
 * Tasks (`io.modelcontextprotocol/tasks`) and RFC 7240's `Prefer: respond-async` define it, and the work goes
 * on in the application's task store, the `MAXIMUS_TASKS` Durable Object binding (`createWorker`'s `tasks`).
 * Without that binding every call runs as before. A task belongs to the caller that started it, runs at most
 * once and is kept for an hour.
 */
import { Type as t } from 'typebox';
import type { Static } from 'typebox';

import { FailureSchema, standardErrors } from './errors.ts';
import type { Failure } from './errors.ts';
import { literalUnion } from './input-schemas.ts';
import { composeOperations, operationScopes } from './manifest.ts';
import type { Invocation, InvocationAuthority, OperationShape } from './manifest.ts';
import type { Principal } from './principal.ts';
import { err, ok } from './result.ts';
import type { Result } from './result.ts';

/** How long a call waits for its task to finish before it answers the task instead. */
export const TASK_WAIT_MS = 1000;
/** How long a task and its result are kept after it starts: long enough to read it, and no longer. */
export const TASK_TTL_MS = 3_600_000;
/** How often a client should ask for a task that is still working. */
export const TASK_POLL_MS = 2000;

/** A task as the store keeps it: the call it runs, as whom, and how it ended. */
export interface TaskRecord {
  /** The application's namespace, a dot, and a random UUID, so a gateway can tell whose task it is. */
  taskId: string;
  operation: string;
  input: unknown;
  principal: Principal;
  /** The verified authority of the call, without its bearer token, which is never stored. */
  authority?: Omit<InvocationAuthority, 'token'>;
  status: 'working' | 'completed' | 'failed' | 'cancelled';
  /** Set before the work runs, so a task found started but still working is never run again. */
  started: boolean;
  result?: Result<unknown, Failure>;
  createdAt: number;
  lastUpdatedAt: number;
}
/** The task store's methods, as the Worker calls its Durable Object. */
export interface TaskStore {
  run: (task: TaskRecord, waitMs: number) => Promise<TaskRecord>;
  get: (taskId: string, principal: Principal) => Promise<TaskRecord | undefined>;
  cancel: (taskId: string, principal: Principal) => Promise<TaskRecord | undefined>;
}
/** One caller's tasks: start one of the application's operations as a task, read one, or cancel one. */
export interface TaskAccess {
  start: (operation: string, input: unknown) => Promise<TaskRecord>;
  get: (taskId: string) => Promise<TaskRecord | undefined>;
  cancel: (taskId: string) => Promise<TaskRecord | undefined>;
}

/** The caller's tasks in the store `env` binds as `MAXIMUS_TASKS`, one per organization, or none without it. */
export function taskAccess(
  namespace: string,
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
  const store = () => binding.get(binding.idFromName(principal.organizationId));
  const kept = authority && {
    surface: authority.surface,
    scopes: authority.scopes,
    client: authority.client,
  };
  return {
    start: (operation, input) => {
      const now = Date.now();
      const taskId = `${namespace}.${crypto.randomUUID()}`;
      const task = { taskId, operation, input, principal, status: 'working' as const, started: false };
      return store().run(
        { ...task, ...(kept ? { authority: kept } : {}), createdAt: now, lastUpdatedAt: now },
        TASK_WAIT_MS
      );
    },
    get: (taskId) => store().get(taskId, principal),
    cancel: (taskId) => store().cancel(taskId, principal),
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
    ttlMs: TASK_TTL_MS,
    pollIntervalMs: TASK_POLL_MS,
    ...(task.result?.ok === true ? { result: task.result.value } : {}),
    ...(task.result?.ok === false ? { error: task.result.error } : {}),
  };
}

/**
 * The operations an application gains when one of its operations declares `task: true`: `GET /v1/tasks/{taskId}`
 * reads a task the caller started and `POST /v1/tasks/{taskId}/cancel` cancels one that has not started
 * running. Either admits any scope of the task operations; someone else's task, or an expired one, is
 * `INVALID_INPUT` at `/taskId`.
 */
export function withTaskOperations<Ops extends Record<string, OperationShape>>(
  operations: Ops,
  namespace: string
): Ops {
  const [first, ...rest] = new Set(
    Object.values(operations).flatMap((op) => (op.task ? operationScopes(op) : []))
  );
  if (first === undefined) {
    return operations;
  }
  const scope = [first, ...rest] as const;
  const answer =
    (method: 'get' | 'cancel') =>
    async ({ env, principal }: Invocation<unknown>, { taskId }: { taskId: string }) => {
      const task = await taskAccess(namespace, env, principal)?.[method](taskId);
      // As MCP answers an unknown task: invalid params, whether it never existed, expired or is another's.
      const issues = [{ path: '/taskId', message: 'must name a task you started' }];
      return task ? ok(taskView(task)) : err(standardErrors.invalidInput.create({ issues }));
    };
  const shared = {
    scope,
    input: t.Object({ taskId: t.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }),
    output: TaskSchema,
    // The handler reads the store as the verified caller, without the application's own context.
    pipeline: { context: (invocation: never) => Promise.resolve(ok(invocation)), middleware: [] },
  };
  return composeOperations(operations, {
    getTask: {
      ...shared,
      title: 'Read a task',
      description: "Read a task you started: whether it still works, then the operation's value or failure.",
      effect: 'read',
      http: { method: 'GET', path: '/v1/tasks/{taskId}' },
      execute: answer('get') as OperationShape['execute'],
    },
    cancelTask: {
      ...shared,
      title: 'Cancel a task',
      description: 'Cancel a task you started that has not started running; one that has runs to its end.',
      effect: 'write',
      http: { method: 'POST', path: '/v1/tasks/{taskId}/cancel' },
      execute: answer('cancel') as OperationShape['execute'],
    },
  }) as Ops;
}
