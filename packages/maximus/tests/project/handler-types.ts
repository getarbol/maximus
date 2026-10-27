/**
 * Compile-only coverage of file declarations: schemas from fields, the registered context and catalog,
 * `fail` held to declared codes and their data, the fields a declaration may name, and the names, effects
 * and exposures binding derives for the client and native RPC.
 */
import { defineAuth, defineContext, defineHandler, defineTool, t } from '../../src/index.ts';
import type { Failed, HandlerOptions, PreparedContext, Principal, Static } from '../../src/index.ts';
import { bindRoute, bindTool } from '../../src/project/config.ts';
import type { ToolMcpName, ToolName } from '../../src/project/config.ts';
import type { RpcMethods } from '../../src/workers/runtime.ts';
import { base } from './fixtures/registered.ts';

const task = { taskId: t.String(), title: t.String() };

const complete = defineHandler(
  ({ input, prefix, principal, fail }) => {
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
    // @ts-expect-error Only admission answers an unknown route or a refused token, never a handler.
    void fail('UNAUTHORIZED');
    // @ts-expect-error A body's own failures come from reading it, never from `fail`.
    void fail('REQUEST_TOO_LARGE');
    return { taskId: id, title: `${prefix} task` };
  },
  {
    input: { taskId: t.String() },
    output: task,
    failures: ['TASK_NOT_FOUND'],
    rpc: true,
  }
);

defineHandler(
  // @ts-expect-error The output keeps its schema's types.
  () => ({ taskId: 1, title: 'task' }),
  {
    output: task,
  }
);
defineHandler(
  // @ts-expect-error Only fail creates a failure: an object of the same shape is no answer.
  () => ({ failure: { code: 'FORBIDDEN', message: '', retryable: false, data: {} } }),
  {
    output: { count: t.Integer() },
  }
);
defineHandler(
  // @ts-expect-error Data that QUOTA_REACHED does not declare.
  ({ fail }) => fail('QUOTA_REACHED', { limit: 'many' }),
  {
    output: { count: t.Integer() },
  }
);
defineHandler(
  // @ts-expect-error QUOTA_REACHED requires its data.
  ({ fail }) => fail('QUOTA_REACHED'),
  {
    output: { count: t.Integer() },
  }
);
defineHandler(() => ({ count: 1 }), {
  output: { count: t.Integer() },
  // @ts-expect-error Only the catalog's domain codes are declared failures.
  failures: ['NOT_A_CODE'],
});
defineHandler(() => ({ count: 1 }), {
  output: { count: t.Integer() },
  // @ts-expect-error A field no route has, such as a path the filename owns.
  path: '/v1/elsewhere',
});
// @ts-expect-error A route that is an MCP tool describes what it does.
defineHandler(() => ({ count: 1 }), {
  output: { count: t.Integer() },
  mcp: { name: 'count_tasks' },
});
defineHandler(
  async ({ body }) => {
    const read = await body.read();
    // A failure to read the body is one the route answers as it is.
    return read.ok ? { count: read.value.byteLength } : read.error;
  },
  {
    output: { count: t.Integer() },
    http: { body: 'bytes' },
  }
);
defineHandler(
  // @ts-expect-error The body's failure is answered as it is, never unwrapped into the output.
  async ({ body }) => {
    const read = await body.read();
    return read.ok ? read.value.byteLength : read.error.failure;
  },
  {
    output: t.Integer(),
    http: { body: 'bytes' },
  }
);
defineHandler(
  // @ts-expect-error Only a route that declares a byte body reads one.
  async ({ body }) => ({ count: (await body.read()).ok ? 1 : 0 }),
  {
    output: { count: t.Integer() },
  }
);

// Without a contract, a route takes no input and answers the empty object: its handler returns nothing.
defineHandler(async ({ principal }) => {
  void principal.organizationId;
});
// @ts-expect-error A route that declares no output answers nothing of its own.
defineHandler(() => ({ count: 1 }));
// @ts-expect-error The handler comes first, then its contract.
defineHandler({ output: { count: t.Integer() }, handler: () => ({ count: 1 }) });

// A contract kept in a const keeps its types with satisfies.
const contract = {
  input: { taskId: t.String() },
  output: { done: t.Boolean() },
  failures: ['TASK_NOT_FOUND'],
} satisfies HandlerOptions;
defineHandler(({ input, fail }) => {
  const id: string = input.taskId;
  // @ts-expect-error Input from a kept contract holds only its declared fields.
  void input.title;
  return id ? { done: true } : fail('TASK_NOT_FOUND');
}, contract);

const listed = defineHandler(() => ({ tasks: [] }), {
  output: { tasks: t.Array(t.Object(task, { additionalProperties: false })) },
  description: 'List the tasks.',
  mcp: { name: 'list_tasks' },
});
const summarize = defineTool(({ prefix }) => ({ summary: prefix }), {
  description: 'Summarize the open tasks.',
  effect: 'read',
  output: { summary: t.String() },
  rpc: true,
});
// @ts-expect-error A tool states its effect.
defineTool(() => ({ summary: '' }), { description: 'No effect.', output: { summary: t.String() } });

const app = base
  .mount(bindRoute(base, complete, '/v1/tasks/{taskId}/complete', 'POST', 'completeTask'))
  .mount(bindRoute(base, listed, '/v1/tasks', 'GET', 'listTasks'))
  .mount(bindTool(base, summarize, 'summarize-tasks'))
  .build();
const effect: 'write' = app.operations.completeTask.effect;
const read: 'read' = app.operations.listTasks.effect;
const path: '/v1/tasks/{taskId}/complete' = app.operations.completeTask.http.path;
const tool: 'summarize_tasks' = app.operations.summarizeTasks.mcp.name;
void [effect, read, path, tool];

type Completion = Static<typeof app.operations.completeTask.input>;
const completion: Completion = { taskId: 'task-1' };
// @ts-expect-error The operation keeps the route's input.
const wrongCompletion: Completion = { taskId: 1 };
// @ts-expect-error An MCP-only tool has no HTTP route.
void app.operations.summarizeTasks.http;
// @ts-expect-error A route without mcp is no MCP tool.
void app.operations.completeTask.mcp.name;
void [completion, wrongCompletion];

declare const rpc: RpcMethods<typeof app.operations>;
declare const principal: Principal;
void rpc.completeTask(principal, { taskId: 'task-1' });
void rpc.summarizeTasks(principal, {});
// @ts-expect-error A route without rpc is no RPC method.
void rpc.listTasks;

// @ts-expect-error A route is named by the name prepare derives, never by its method and path spelled out.
void app.operations.postV1TasksTaskIdComplete;
const toolName: ToolName<'summarize-open-tasks'> = 'summarizeOpenTasks';
const mcpName: ToolMcpName<'summarize-open-tasks'> = 'summarize_open_tasks';
void [toolName, mcpName];

const prepared = defineContext(({ env, principal: caller, fail }) => {
  const prefix: string = env.PREFIX;
  // @ts-expect-error The registered bindings keep their types.
  const wrong: number = env.PREFIX;
  // @ts-expect-error A context fails with codes of the catalog.
  void fail('NOT_A_CODE');
  // @ts-expect-error Only routing answers an unknown route, never a context.
  void fail('NOT_FOUND');
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
defineAuth({
  resolve: async () => ({ actorId: 'worker', actorKind: 'service', organizationId: 'org_acme', scopes: [] }),
  // @ts-expect-error Beside resolve, the issuer is still configuration.
  issuer: 'https://issuer.example.test/',
});

declare const preparedContext: PreparedContext<typeof prepared>;
const preparedLabel: string = preparedContext.label;
const preparedPrefix: string = preparedContext.env.PREFIX;
// @ts-expect-error A failure is no part of the prepared context.
void preparedContext.failure;
void [preparedLabel, preparedPrefix];
