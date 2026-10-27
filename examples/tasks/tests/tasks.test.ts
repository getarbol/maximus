/**
 * The tasks service in Node, through the API the Worker serves, over a Workers KV stand-in: a task's life
 * from creation to deletion, refusals, MCP with its tools, guide and skill, and, through the store itself,
 * that one organization never reaches another's tasks and that a stored value its schema refuses is never
 * answered.
 */
import { beforeEach, expect, it } from 'vite-plus/test';

import { handler } from '#maximus/http';
import { taskStore } from '#src/tasks.ts';
import type { Task } from '#src/tasks.ts';

import { testNamespace } from './kv.ts';

/** The development token `vp test` accepts from localhost, as a developer holding every scope. */
const token = 'test-development-token-for-local-tests';
let env: Env;

beforeEach(() => {
  env = { DEVELOPMENT_TOKEN: token, TASKS: testNamespace() } as Env;
});

/** Calls the API with the development token, sending `body` as JSON when there is one. */
async function call(method: string, path: string, body?: unknown) {
  const response = await handler(
    new Request(`http://localhost/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env
  );
  return { status: response.status, body: (await response.json()) as { data: unknown; error: unknown } };
}

/** Calls an MCP method with the development token and answers its result. */
async function callMcp(method: string, params: object = {}) {
  const response = await handler(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
    env
  );
  const text = await response.text();
  return (JSON.parse(/data: (\{[^\n]*)/u.exec(text)?.[1] ?? text) as { result: Record<string, unknown> })
    .result;
}

it('creates a task, completes it, lists it and deletes it', async () => {
  const created = await call('POST', '/v1/tasks', { title: 'Send the invoice to Acme' });
  expect(created).toMatchObject({
    status: 201,
    body: { data: { title: 'Send the invoice to Acme', done: false } },
  });
  const task = created.body.data as Task;
  const completed = await call('POST', `/v1/tasks/${task.taskId}/complete`, {});
  expect(completed.body.data).toEqual({ ...task, done: true });
  // Completing a done task changes nothing.
  expect((await call('POST', `/v1/tasks/${task.taskId}/complete`, {})).body.data).toEqual({
    ...task,
    done: true,
  });
  expect((await call('GET', '/v1/tasks')).body.data).toEqual({ tasks: [{ ...task, done: true }] });
  expect((await call('DELETE', `/v1/tasks/${task.taskId}`)).status).toBe(200);
  expect(await call('GET', `/v1/tasks/${task.taskId}`)).toMatchObject({
    status: 404,
    body: { error: { code: 'TASK_NOT_FOUND' } },
  });
  // Deleting a missing task changes nothing; completing one is refused.
  expect((await call('DELETE', `/v1/tasks/${task.taskId}`)).status).toBe(200);
  expect((await call('POST', `/v1/tasks/${task.taskId}/complete`, {})).status).toBe(404);
});

it('refuses an empty title, fields it does not know, an id that is no UUID and a body that is no JSON', async () => {
  for (const [method, path, body] of [
    ['POST', '/v1/tasks', { title: '' }],
    ['POST', '/v1/tasks', { title: 'Call Acme', done: true }],
    ['GET', '/v1/tasks/42', undefined],
    ['POST', `/v1/tasks/${crypto.randomUUID()}/complete`, { taskId: crypto.randomUUID() }],
  ] as const) {
    expect((await call(method, path, body)).status, `${method} ${path}`).toBe(400);
  }
  const unparsed = await handler(
    new Request('http://localhost/api/v1/tasks', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{"title":',
    }),
    env
  );
  expect(unparsed.status).toBe(400);
});

it('serves its tools, its guide and its skill over MCP', async () => {
  await call('POST', '/v1/tasks', { title: 'Renew the domain' });
  const tools = (await callMcp('tools/list')).tools as { name: string }[];
  expect(tools.map(({ name }) => name).toSorted()).toEqual([
    'complete_task',
    'list_tasks',
    'summarize_tasks',
  ]);
  expect(await callMcp('tools/call', { name: 'summarize_tasks', arguments: {} })).toMatchObject({
    structuredContent: { open: 1, done: 0, summary: '1 open and 0 done.' },
  });
  const resources = (await callMcp('resources/list')).resources as { uri: string }[];
  expect(resources.map(({ uri }) => uri)).toEqual(
    expect.arrayContaining([
      'https://example-tasks.example.workers.dev/guides/task-conventions',
      'skill://weekly-review/SKILL.md',
    ])
  );
  expect(await callMcp('resources/read', { uri: 'skill://weekly-review/SKILL.md' })).toMatchObject({
    contents: [{ text: expect.stringContaining('# Weekly review') }],
  });
});

it('keeps each organization to its own tasks, and never answers a stored value its schema refuses', async () => {
  const namespace = testNamespace();
  const clinic = taskStore(namespace, 'org_clinic');
  const lab = taskStore(namespace, 'org_lab');
  const task = await clinic.create('Restock gloves');
  expect(await lab.find(task.taskId)).toBeUndefined();
  expect(await lab.complete(task.taskId)).toBeUndefined();
  expect(await lab.list()).toEqual([]);
  await lab.delete(task.taskId);
  expect(await clinic.find(task.taskId)).toEqual(task);

  const taskId = crypto.randomUUID();
  await env.TASKS.put(`tasks/local-development/${taskId}`, JSON.stringify({ taskId, title: 7 }));
  expect(await call('GET', `/v1/tasks/${taskId}`)).toMatchObject({
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR' } },
  });
});

it('refuses a caller without a token', async () => {
  expect((await handler(new Request('http://localhost/api/v1/tasks'), env)).status).toBe(401);
});
