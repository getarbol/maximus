/**
 * File declarations at runtime: a route bound under its path and method and a tool under its file's name,
 * what binding derives (names, effects, scopes, titles and tool hints), schemas from fields, `fail` answering
 * catalog failures, and the shared execution path still checking failures, input and output once.
 */
import { describe, expect, it } from 'vite-plus/test';

import { createHttpHandler, createOpenApi, defineHandler, defineTool, t } from '../../src/index.ts';
import type { AppManifest, OperationShape } from '../../src/index.ts';
import { bindRoute, bindTool, routeName, toolName } from '../../src/project/config.ts';
import { base } from './fixtures/registered.ts';
import type { Env } from './fixtures/registered.ts';

/** The development token the fixture's policy accepts from localhost: every declared scope. */
const TOKEN = 'local-development-token-0123456789';
const env: Env = { PREFIX: 'Task', DEVELOPMENT_TOKEN: TOKEN };

/** Calls a route of the application from localhost with the development token. */
async function call<C, O extends Record<string, OperationShape>>(
  app: AppManifest<Env, C, O>,
  method: string,
  path: string,
  body?: unknown
) {
  const response = await createHttpHandler(app)(
    new Request(`http://localhost:5173${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const task = { taskId: t.String(), title: t.String() };
const complete = defineHandler({
  input: { taskId: t.String({ minLength: 1 }) },
  output: task,
  failures: ['TASK_NOT_FOUND'],
  handler: ({ input, prefix, fail }) =>
    input.taskId === 'missing' ? fail('TASK_NOT_FOUND') : { taskId: input.taskId, title: `${prefix} done` },
});
const list = defineHandler({
  output: { tasks: t.Array(t.String()) },
  description: 'List the tasks.',
  mcp: { name: 'list_tasks' },
  handler: async ({ prefix }) => ({ tasks: [`${prefix} one`] }),
});

describe('routes', () => {
  const app = base
    .mount(bindRoute(base, complete, '/v1/tasks/{taskId}/complete', 'POST'))
    .mount(bindRoute(base, list, '/v1/tasks', 'GET'))
    .build();

  it('derive the name, effect, scope, title and tool hints a declaration leaves out', () => {
    expect(app.operations.postV1TasksTaskIdComplete).toMatchObject({
      title: 'POST /v1/tasks/{taskId}/complete',
      description: '',
      effect: 'write',
      scope: 'tasks:tasks:write',
      http: { method: 'POST', path: '/v1/tasks/{taskId}/complete' },
      failures: ['TASK_NOT_FOUND'],
    });
    expect(app.operations.getV1Tasks).toMatchObject({
      title: 'List tasks',
      effect: 'read',
      scope: 'tasks:tasks:read',
      mcp: { name: 'list_tasks', idempotent: true },
    });
  });

  it('answer their output, and a declared failure through fail', async () => {
    expect(await call(app, 'POST', '/v1/tasks/task-1/complete', {})).toMatchObject({
      status: 200,
      body: { success: true, data: { taskId: 'task-1', title: 'Task done' } },
    });
    expect(await call(app, 'POST', '/v1/tasks/missing/complete', {})).toMatchObject({
      status: 404,
      body: { success: false, error: { code: 'TASK_NOT_FOUND' } },
    });
    expect(await call(app, 'GET', '/v1/tasks')).toMatchObject({
      status: 200,
      body: { data: { tasks: ['Task one'] } },
    });
  });

  it('take strict objects from fields: an unknown input field is refused', async () => {
    expect(await call(app, 'POST', '/v1/tasks/task-1/complete', { extra: true })).toMatchObject({
      status: 400,
      body: { error: { code: 'INVALID_INPUT' } },
    });
  });

  it('document only what they declare', () => {
    const document = createOpenApi(app) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const completed = document.paths['/v1/tasks/{taskId}/complete']?.post;
    expect(completed).toMatchObject({
      operationId: 'postV1TasksTaskIdComplete',
      summary: 'POST /v1/tasks/{taskId}/complete',
      'x-required-scopes': ['tasks:tasks:write'],
      'x-effect': 'write',
    });
    expect(completed).not.toHaveProperty('description');
    expect(document.paths['/v1/tasks']?.get).toMatchObject({
      description: 'List the tasks.',
      'x-mcp-tool': 'list_tasks',
      'x-mcp-idempotent': true,
    });
  });

  it('keep what a declaration names over what binding would derive', () => {
    const declared = defineHandler({
      title: 'Search tasks',
      operationId: 'searchTasks',
      effect: 'read',
      scope: 'tasks:search:read',
      input: { query: t.String() },
      output: { count: t.Integer() },
      description: 'Search without changing anything.',
      mcp: { name: 'search_tasks', idempotent: false, openWorld: false },
      handler: () => ({ count: 0 }),
    });
    const searched = base.mount(bindRoute(base, declared, '/v1/tasks/search', 'POST')).build();
    expect(searched.operations.searchTasks).toMatchObject({
      title: 'Search tasks',
      effect: 'read',
      scope: 'tasks:search:read',
      mcp: { name: 'search_tasks', idempotent: false, openWorld: false },
    });
  });

  it('name a resource in kebab-case and delete with a write scope', () => {
    const removed = defineHandler({ input: { listId: t.String() }, output: {}, handler: () => ({}) });
    const lists = base.mount(bindRoute(base, removed, '/v1/taskLists/{listId}', 'DELETE')).build();
    expect(lists.operations.deleteV1TaskListsListId).toMatchObject({
      effect: 'delete',
      scope: 'tasks:task-lists:write',
    });
    expect(lists.operations.deleteV1TaskListsListId).not.toHaveProperty('mcp');
  });

  it('read a declared byte body', async () => {
    const upload = defineHandler({
      input: { taskId: t.String() },
      output: { bytes: t.Integer() },
      http: { body: 'bytes' },
      handler: async ({ body }) => {
        const read = await body.read();
        return { bytes: read.ok ? read.value.byteLength : -1 };
      },
    });
    const uploads = base.mount(bindRoute(base, upload, '/v1/tasks/{taskId}/attachment', 'PUT')).build();
    const response = await createHttpHandler(uploads)(
      new Request('http://localhost:5173/v1/tasks/task-1/attachment', {
        method: 'PUT',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/octet-stream' },
        body: new Uint8Array([1, 2, 3]),
      }),
      env
    );
    expect(await response.json()).toMatchObject({ data: { bytes: 3 } });
  });
});

describe('the execution path', () => {
  it('still refuses a failure the route does not declare, and an unknown code', async () => {
    const undeclared = defineHandler({
      output: {},
      failures: ['TASK_NOT_FOUND'],
      // A handler that escapes its types reaches the same checks as any other.
      handler: ({ fail }) => (fail as (code: string, data?: object) => never)('QUOTA_REACHED', { limit: 1 }),
    });
    const unknown = defineHandler({
      output: {},
      handler: ({ fail }) => (fail as (code: string) => never)('NOT_IN_THE_CATALOG'),
    });
    const app = base
      .mount(bindRoute(base, undeclared, '/v1/undeclared', 'POST'))
      .mount(bindRoute(base, unknown, '/v1/unknown', 'POST'))
      .build();
    for (const path of ['/v1/undeclared', '/v1/unknown']) {
      expect(await call(app, 'POST', path, {}), path).toMatchObject({
        status: 500,
        body: { error: { code: 'INTERNAL_ERROR' } },
      });
    }
  });

  it('answers a failure with the data its code declares', async () => {
    const quota = defineHandler({
      output: {},
      handler: ({ fail }) => fail('QUOTA_REACHED', { limit: 3 }),
    });
    const app = base.mount(bindRoute(base, quota, '/v1/quota', 'POST')).build();
    expect(await call(app, 'POST', '/v1/quota', {})).toMatchObject({
      status: 429,
      body: { error: { code: 'QUOTA_REACHED', data: { limit: 3 } } },
    });
  });

  it('checks the output once: a lookalike failure or an extra field is no answer', async () => {
    const lookalike = defineHandler({
      output: {},
      handler: () => ({ failure: { code: 'TASK_NOT_FOUND' } }) as never,
    });
    const extra = defineHandler({ output: { count: t.Integer() }, handler: () => ({ count: 1, more: 2 }) });
    const app = base
      .mount(bindRoute(base, lookalike, '/v1/lookalike', 'POST'))
      .mount(bindRoute(base, extra, '/v1/extra', 'POST'))
      .build();
    for (const path of ['/v1/lookalike', '/v1/extra']) {
      expect((await call(app, 'POST', path, {})).status, path).toBe(500);
    }
  });
});

describe('binding refuses', () => {
  it('a default export that defineHandler or defineTool did not declare', () => {
    expect(() => bindRoute(base, {} as typeof list, '/v1/tasks', 'GET')).toThrow(
      "GET /v1/tasks: a route file's default export must come from defineHandler."
    );
    expect(() => bindTool(base, list as never, 'list-tasks')).toThrow('must come from defineTool');
  });

  it('a route whose path names no resource and that declares no scope', () => {
    const item = defineHandler({ input: { id: t.String() }, output: {}, handler: () => ({}) });
    expect(() => bindRoute(base, item, '/v1/{id}', 'GET')).toThrow('declare its scope');
    const scoped = defineHandler({
      scope: 'tasks:items:read',
      input: { id: t.String() },
      output: {},
      handler: () => ({}),
    });
    expect(base.mount(bindRoute(base, scoped, '/v1/{id}', 'GET')).build().operations.getV1Id.scope).toBe(
      'tasks:items:read'
    );
  });

  it('a DELETE route that declares it only reads, which would take a read scope', () => {
    const removal = defineHandler({ output: {}, effect: 'read', handler: () => ({}) });
    expect(() => bindRoute(base, removal, '/v1/tasks/{taskId}', 'DELETE')).toThrow(
      'DELETE /v1/tasks/{taskId}: a DELETE route deletes; its effect is delete or write, never read.'
    );
  });

  it('an MCP route without a description, even when its types are bypassed', () => {
    const silent = defineHandler({
      output: {},
      mcp: { name: 'silent' },
      description: ' ',
      handler: () => ({}),
    });
    expect(() => bindRoute(base, silent, '/v1/silent', 'GET')).toThrow('describes what it does');
  });

  it('a field no operation has, which `.build()` names', () => {
    const misspelling = { visiblity: 'internal' };
    const misspelled = defineHandler({ output: {}, handler: () => ({}), ...misspelling });
    expect(() => base.mount(bindRoute(base, misspelled, '/v1/misspelled', 'GET')).build()).toThrow(
      '"visiblity" is not an operation field'
    );
  });
});

describe('tools', () => {
  const summarize = defineTool({
    description: 'Summarize the open tasks.',
    effect: 'read',
    input: { limit: t.Integer({ minimum: 1 }) },
    output: { summary: t.String() },
    handler: ({ input, prefix }) => ({ summary: `${input.limit} ${prefix}` }),
  });
  const archive = defineTool({
    description: 'Archive the done tasks.',
    effect: 'write',
    output: { archived: t.Integer() },
    openWorld: false,
    handler: () => ({ archived: 0 }),
  });

  it('are named by their file and serve only MCP', () => {
    const app = base
      .mount(bindTool(base, summarize, 'summarize-tasks'))
      .mount(bindTool(base, archive, 'archive-done'))
      .build();
    expect(app.operations.summarizeTasks).toMatchObject({
      title: 'Summarize tasks',
      effect: 'read',
      scope: 'tasks:summarize-tasks:read',
      mcp: { name: 'summarize_tasks', idempotent: true },
    });
    expect(app.operations.summarizeTasks).not.toHaveProperty('http');
    expect(app.operations.archiveDone).toMatchObject({
      scope: 'tasks:archive-done:write',
      mcp: { name: 'archive_done', idempotent: false, openWorld: false },
    });
    expect((createOpenApi(app) as { paths: object }).paths).toEqual({});
  });

  it('refuse a file name that is not kebab-case', () => {
    expect(() => bindTool(base, summarize, 'Summarize_Tasks')).toThrow('kebab-case');
  });
});

it('derives at runtime the names the types derive', () => {
  expect(routeName('DELETE', '/v1/task-lists/{list_id}')).toBe('deleteV1TaskListsListId');
  expect(routeName('GET', '/v1/greeting')).toBe('getV1Greeting');
  expect(toolName('summarize-open-tasks')).toBe('summarizeOpenTasks');
});
