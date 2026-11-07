/**
 * The MCP Tasks extension (`io.modelcontextprotocol/tasks`, revision 2026-07-28) on the official SDK, in the
 * wire format of `@modelcontextprotocol/ext-tasks`: the declared extension, `tasks/get` and `tasks/cancel`, and
 * a task as a client reads it. `@arbol-ai/maximus/mcp/tasks` exports it, so a gateway serves the same methods
 * for the tasks it relays.
 */
import {
  CancelTaskRequestV2Schema,
  GetTaskRequestV2Schema,
  TASKS_EXTENSION_ID_V2,
} from '@modelcontextprotocol/ext-tasks/core/v2';
import type { DetailedTaskV2 } from '@modelcontextprotocol/ext-tasks/core/v2';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';

import type { Failure, Result } from '../index.ts';
import { TASK_POLL_MS, TASK_TTL_MS } from '../tasks.ts';
import type { TaskAccess, TaskRecord } from '../tasks.ts';

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
export function mcpTask(task: TaskRecord): DetailedTaskV2 {
  const state = {
    taskId: task.taskId,
    createdAt: new Date(task.createdAt).toISOString(),
    lastUpdatedAt: new Date(task.lastUpdatedAt).toISOString(),
    ttlMs: TASK_TTL_MS,
    pollIntervalMs: TASK_POLL_MS,
  };
  return (
    task.result
      ? { ...state, status: 'completed', result: toolResult(task.result) }
      : { ...state, status: task.status === 'cancelled' ? 'cancelled' : 'working' }
  ) as DetailedTaskV2;
}

/**
 * Declares the Tasks extension on `server` and serves `tasks/get` and `tasks/cancel` for the caller's tasks. A
 * task id the caller did not start, or one that expired, is invalid params (-32602).
 */
export function attachTasks(server: McpServer, tasks: TaskAccess): void {
  server.server.registerCapabilities({ extensions: { [TASKS_EXTENSION_ID_V2]: {} } });
  const find = async (method: 'get' | 'cancel', taskId: string) => {
    const task = await tasks[method](taskId);
    if (!task) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown task');
    }
    return task;
  };
  server.server.setRequestHandler(
    'tasks/get',
    { params: GetTaskRequestV2Schema.shape.params },
    async ({ taskId }) => mcpTask(await find('get', taskId))
  );
  server.server.setRequestHandler(
    'tasks/cancel',
    { params: CancelTaskRequestV2Schema.shape.params },
    async ({ taskId }) => {
      await find('cancel', taskId);
      return {};
    }
  );
}
