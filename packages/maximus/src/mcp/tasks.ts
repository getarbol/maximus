/**
 * The MCP Tasks extension (`io.modelcontextprotocol/tasks`, revision 2026-07-28) on the official SDK, in the
 * wire format `@modelcontextprotocol/ext-tasks` defines: the declared extension, `tasks/get` and `tasks/cancel`,
 * a task as a client reads it, and the checks a relay needs. They are a few lines of their own rather than that
 * package's guards, which load all of zod. `@arbol-ai/maximus/mcp/tasks` exports them, so a gateway serves the
 * same methods for the tasks it relays.
 */
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { CallToolResult, McpServer, StandardSchemaV1 } from '@modelcontextprotocol/server';

import type { Failure, Result } from '../index.ts';
import { TASK_POLL_MS } from '../tasks.ts';
import type { TaskAccess, TaskRecord } from '../tasks.ts';

export type { TaskAccess, TaskRecord } from '../tasks.ts';

/** The Tasks extension's id, which a client declares on each request and a server among its capabilities. */
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

/** A task as an MCP client reads it, a JSON-RPC result. A failed operation completes the task with a tool error. */
export type McpTask = {
  taskId: string;
  status: 'working' | 'completed' | 'cancelled';
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number;
  pollIntervalMs: number;
  /** The tool call's result, once completed. */
  result?: CallToolResult;
};

/** The value, when it is a plain object. */
const record = (value: unknown) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Whether a request's `_meta` declares the Tasks extension: an empty object at
 * `io.modelcontextprotocol/clientCapabilities` › `extensions` › `io.modelcontextprotocol/tasks`, as
 * `@modelcontextprotocol/ext-tasks` reads it.
 */
export function declaresTasks(meta: unknown): boolean {
  const capabilities = record(record(meta)?.['io.modelcontextprotocol/clientCapabilities']);
  const extensions = record(capabilities?.extensions);
  const declared =
    extensions && Object.hasOwn(extensions, TASKS_EXTENSION)
      ? record(extensions[TASKS_EXTENSION])
      : undefined;
  return declared !== undefined && Object.keys(declared).length === 0;
}

/** Whether a `tools/call` result is a task the server created, `resultType: "task"`, rather than the call's result. */
export function isTaskResult(result: unknown): boolean {
  const task = record(result);
  return (
    task?.resultType === 'task' &&
    typeof task.taskId === 'string' &&
    ['working', 'input_required', 'completed', 'failed', 'cancelled'].includes(String(task.status))
  );
}

/** A Result as a tool call answers it: the value, or the failure as a tool error the model can read. */
export function toolResult(result: Result<unknown, Failure>): CallToolResult {
  return result.ok
    ? {
        content: [{ type: 'text', text: JSON.stringify(result.value) }],
        structuredContent: result.value as Record<string, unknown>,
      }
    : { isError: true, content: [{ type: 'text', text: JSON.stringify(result.error) }] };
}

/** A task as an MCP client reads it. A failed operation completes its tool call with a tool error. */
export function mcpTask(task: TaskRecord): McpTask {
  const state = {
    taskId: task.taskId,
    createdAt: new Date(task.createdAt).toISOString(),
    lastUpdatedAt: new Date(task.lastUpdatedAt).toISOString(),
    ttlMs: task.ttlMs,
    pollIntervalMs: TASK_POLL_MS,
  };
  if (task.result) {
    return { ...state, status: 'completed', result: toolResult(task.result) };
  }
  return { ...state, status: task.status === 'cancelled' ? 'cancelled' : 'working' };
}

/** The params of `tasks/get` and `tasks/cancel`: the task's id. */
const TaskIdParams: StandardSchemaV1<unknown, { taskId: string }> = {
  '~standard': {
    version: 1,
    vendor: 'maximus',
    validate: (params) => {
      const taskId = record(params)?.taskId;
      return typeof taskId === 'string'
        ? { value: { taskId } }
        : { issues: [{ message: 'taskId is a string' }] };
    },
  },
};

/**
 * Declares the Tasks extension on `server` and serves `tasks/get` and `tasks/cancel` for the caller's tasks. A
 * task id the caller did not start, or one that expired, is invalid params (-32602).
 */
export function attachTasks(server: McpServer, tasks: TaskAccess): void {
  server.server.registerCapabilities({ extensions: { [TASKS_EXTENSION]: {} } });
  const find = async (method: 'get' | 'cancel', taskId: string) => {
    const task = await tasks[method](taskId);
    if (!task) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown task');
    }
    return task;
  };
  server.server.setRequestHandler('tasks/get', { params: TaskIdParams }, async ({ taskId }) =>
    mcpTask(await find('get', taskId))
  );
  server.server.setRequestHandler('tasks/cancel', { params: TaskIdParams }, async ({ taskId }) => {
    await find('cancel', taskId);
    return {};
  });
}
