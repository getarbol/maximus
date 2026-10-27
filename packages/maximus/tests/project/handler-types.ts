import type { AppClientContract, ReadOperationName } from '../../src/client/client.ts';
/**
 * Compile-only coverage of file declarations: schemas from fields, the registered context and catalog,
 * `fail` held to declared codes and their data, the fields a declaration may name, and the names, effects
 * and exposures binding derives for the client and native RPC.
 */
import { defineAuth, defineContext, defineHandler, defineTool, t } from '../../src/index.ts';
import type { Failed, PreparedContext, Principal } from '../../src/index.ts';
import { bindRoute, bindTool } from '../../src/project/config.ts';
import type { RouteName, ToolMcpName, ToolName } from '../../src/project/config.ts';
import type { RpcMethods } from '../../src/workers/runtime.ts';
import { base } from './fixtures/registered.ts';

const task = { taskId: t.String(), title: t.String() };

const complete = defineHandler({
  input: { taskId: t.String() },
  output: task,
  failures: ['TASK_NOT_FOUND'],
  rpc: true,
  handler: ({ input, prefix, principal, fail }) => {
    const id: string = input.taskId;
    const organization: string = principal.organizationId;
    // @ts-expect-error The registered context keeps its string prefix.
    const count: number = prefix;
    // @ts-expect-error Input holds only its declared fields.
    void input.title;
    void [organization, count];
    if (!id) {
      return fail('TASK_NOT_FOUND');
    }
    // @ts-expect-error A domain failure the route does not declare.
    void fail('QUOTA_REACHED', { limit: 1 });
    // @ts-expect-error A code no catalog defines.
    void fail('MISSING');
    // Standard failures need no declaration.
    void fail('FORBIDDEN');
    return { taskId: id, title: `${prefix} task` };
  },
});

defineHandler({
  output: task,
  // @ts-expect-error The output keeps its schema's types.
  handler: () => ({ taskId: 1, title: 'task' }),
});
defineHandler({
  output: { count: t.Integer() },
  // @ts-expect-error Only fail creates a failure: an object of the same shape is no answer.
  handler: () => ({ failure: { code: 'FORBIDDEN', message: '', retryable: false, data: {} } }),
});
defineHandler({
  output: { count: t.Integer() },
  // @ts-expect-error Data that QUOTA_REACHED does not declare.
  handler: ({ fail }) => fail('QUOTA_REACHED', { limit: 'many' }),
});
defineHandler({
  output: { count: t.Integer() },
  // @ts-expect-error QUOTA_REACHED requires its data.
  handler: ({ fail }) => fail('QUOTA_REACHED'),
});
defineHandler({
  output: { count: t.Integer() },
  // @ts-expect-error Only the catalog's domain codes are declared failures.
  failures: ['NOT_A_CODE'],
  handler: () => ({ count: 1 }),
});
defineHandler({
  output: { count: t.Integer() },
  // @ts-expect-error A field no route has, such as a path the filename owns.
  path: '/v1/elsewhere',
  handler: () => ({ count: 1 }),
});
// @ts-expect-error A route that is an MCP tool describes what it does.
defineHandler({
  output: { count: t.Integer() },
  mcp: { name: 'count_tasks' },
  handler: () => ({ count: 1 }),
});
defineHandler({
  output: { count: t.Integer() },
  http: { body: 'bytes' },
  handler: async ({ body }) => {
    const read = await body.read();
    return { count: read.ok ? read.value.byteLength : 0 };
  },
});
defineHandler({
  output: { count: t.Integer() },
  // @ts-expect-error Only a route that declares a byte body reads one.
  handler: async ({ body }) => ({ count: (await body.read()).ok ? 1 : 0 }),
});

const listed = defineHandler({
  output: { tasks: t.Array(t.Object(task, { additionalProperties: false })) },
  description: 'List the tasks.',
  mcp: { name: 'list_tasks' },
  handler: () => ({ tasks: [] }),
});
const summarize = defineTool({
  description: 'Summarize the open tasks.',
  effect: 'read',
  output: { summary: t.String() },
  rpc: true,
  handler: ({ prefix }) => ({ summary: prefix }),
});
// @ts-expect-error A tool states its effect.
defineTool({ description: 'No effect.', output: { summary: t.String() }, handler: () => ({ summary: '' }) });

const app = base
  .mount(bindRoute(base, complete, '/v1/tasks/{taskId}/complete', 'POST'))
  .mount(bindRoute(base, listed, '/v1/tasks', 'GET'))
  .mount(bindTool(base, summarize, 'summarize-tasks'))
  .build();
const effect: 'write' = app.operations.postV1TasksTaskIdComplete.effect;
const read: 'read' = app.operations.getV1Tasks.effect;
const path: '/v1/tasks/{taskId}/complete' = app.operations.postV1TasksTaskIdComplete.http.path;
const tool: 'summarize_tasks' = app.operations.summarizeTasks.mcp.name;
void [effect, read, path, tool];

declare const client: AppClientContract<typeof app>;
void client.postV1TasksTaskIdComplete({ taskId: 'task-1' });
// @ts-expect-error The client keeps the route's input.
void client.postV1TasksTaskIdComplete({ taskId: 1 });
// @ts-expect-error An MCP-only tool has no HTTP client method.
void client.summarizeTasks;
const reads: ReadOperationName<typeof app> = 'getV1Tasks';
// @ts-expect-error A write is not a read.
const write: ReadOperationName<typeof app> = 'postV1TasksTaskIdComplete';
void [reads, write];

declare const rpc: RpcMethods<typeof app.operations>;
declare const principal: Principal;
void rpc.postV1TasksTaskIdComplete(principal, { taskId: 'task-1' });
void rpc.summarizeTasks(principal, {});
// @ts-expect-error A route without rpc is no RPC method.
void rpc.getV1Tasks;

const named: RouteName<'DELETE', '/v1/task-lists/{list_id}'> = 'deleteV1TaskListsListId';
const toolName: ToolName<'summarize-open-tasks'> = 'summarizeOpenTasks';
const mcpName: ToolMcpName<'summarize-open-tasks'> = 'summarize_open_tasks';
void [named, toolName, mcpName];

const prepared = defineContext(({ env, principal: caller, fail }) => {
  const prefix: string = env.PREFIX;
  // @ts-expect-error The registered bindings keep their types.
  const wrong: number = env.PREFIX;
  // @ts-expect-error A context fails with codes of the catalog.
  void fail('NOT_A_CODE');
  void wrong;
  return caller.organizationId ? { label: prefix } : fail('TASK_NOT_FOUND');
});
const label: (args: never) => { label: string } | Failed | Promise<{ label: string } | Failed> =
  prepared.prepare;
void label;
defineAuth({
  resolve: async (token, resolution) => {
    const prefix: string | undefined = resolution?.env.PREFIX;
    void prefix;
    return { actorId: token, actorKind: 'service', organizationId: 'org_acme', scopes: [] };
  },
});
// @ts-expect-error auth.ts states code; the issuer is configuration.
defineAuth({ issuer: 'https://issuer.example.test/' });

declare const preparedContext: PreparedContext<typeof prepared>;
const preparedLabel: string = preparedContext.label;
const preparedPrefix: string = preparedContext.env.PREFIX;
// @ts-expect-error A failure is no part of the prepared context.
void preparedContext.failure;
void [preparedLabel, preparedPrefix];
