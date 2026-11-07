/**
 * Tasks: an operation that declares `task` answers a task once its call outlasts the wait, over HTTP to
 * `Prefer: respond-async` and over MCP to a client that declares the Tasks extension; the task store runs it
 * once, keeps it for its caller alone, and settles a task an interruption left started as OUTCOME_UNKNOWN.
 */
import {
  isCreateTaskResultV2,
  isDetailedTaskV2,
  TASKS_EXTENSION_ID_V2,
} from '@modelcontextprotocol/ext-tasks/core/v2';
import { expect, it } from 'vite-plus/test';

import { createHttpHandler, defineErrors, maximus, ok, t } from '../../src/index.ts';
import { delay } from '../../src/internal/delay.ts';
import { mcp } from '../../src/mcp/index.ts';
import type { TaskRecord } from '../../src/tasks.ts';
import { tasksObject } from '../../src/workers/tasks.ts';

const strict = { additionalProperties: false } as const;
/** Releases the slow calls that are waiting. */
let release = () => {};
let gate = Promise.resolve();
let runs = 0;
const app = maximus<Record<string, unknown>>({
  name: 'jobs',
  namespace: 'jobs',
  title: 'Jobs',
  version: '1',
  origin: 'https://jobs.example.test',
  tokens: { issuer: 'https://issuer.example.test/', audience: 'https://jobs.example.test' },
  errors: defineErrors({}),
  rpc: { callers: [] },
  mcp: {},
})
  .operation(
    'runReport',
    {
      scope: 'jobs:reports:write',
      title: 'Run a report',
      description: 'Run a report.',
      effect: 'write',
      input: t.Object({ slow: t.Boolean() }, strict),
      output: t.Object({ rows: t.Integer() }, strict),
      http: { method: 'POST', path: '/v1/reports' },
      mcp: { name: 'run_report', idempotent: false },
      task: true,
    },
    async (_context, { slow }) => {
      runs += 1;
      if (slow) {
        await gate;
      }
      return ok({ rows: 3 });
    }
  )
  .build();

/** One SQLite Durable Object's storage in memory, its alarms run one at a time, as the platform runs them. */
function namespace(env: Record<string, unknown>) {
  const Store = tasksObject(app);
  const objects = new Map<string, InstanceType<typeof Store>>();
  return {
    idFromName: (name: string) => name,
    get(id: string) {
      let object = objects.get(id);
      if (!object) {
        const data = new Map<string, unknown>();
        let alarms = Promise.resolve();
        const storage = {
          get: async (name: string) => structuredClone(data.get(name)),
          put: async (name: string, value: unknown) => {
            data.set(name, structuredClone(value));
          },
          delete: async (name: string) => data.delete(name),
          list: async ({ prefix }: { prefix: string }) =>
            new Map(
              [...data]
                .filter(([name]) => name.startsWith(prefix))
                .map(([name, value]) => [name, structuredClone(value)])
            ),
          setAlarm: async (time: number) => {
            if (time <= Date.now()) {
              alarms = alarms.then(() => created.alarm?.());
            }
          },
        };
        const created = new Store({ storage } as never, env);
        object = created;
        objects.set(id, created);
      }
      return object;
    },
  };
}
const env: Record<string, unknown> = {};
env.MAXIMUS_TASKS = namespace(env);
/** A token of `person`, or of anyone else in the same organization. */
const claims = (sub = 'person') => ({
  sub: `${sub}@clients`,
  client_id: sub,
  org_id: 'org_1234567890abcdef',
  scope: 'jobs:reports:write jobs:mcp:use',
});
const handler = (sub?: string) =>
  createHttpHandler(app, { transports: [mcp()], verify: async () => claims(sub) });

/** An HTTP call to the service, as `sub`. */
async function call(
  method: string,
  path: string,
  body?: object,
  headers: Record<string, string> = {},
  sub?: string
) {
  const response = await handler(sub)(
    new Request(`https://jobs.example.test${path}`, {
      method,
      headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json', ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    env
  );
  return { status: response.status, headers: response.headers, body: JSON.parse(await response.text()) };
}
/** A JSON-RPC request a 2026-07-28 client posts that declares the Tasks extension. */
async function modern(method: string, params: Record<string, unknown>, name: string, sub?: string) {
  const response = await handler(sub)(
    new Request('https://jobs.example.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer a.b.c',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        'mcp-name': name,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': { extensions: { [TASKS_EXTENSION_ID_V2]: {} } },
          },
        },
      }),
    }),
    env
  );
  return JSON.parse(await response.text());
}
const slowly = () => {
  // oxlint-disable-next-line promise/avoid-new -- A slow call waits at this gate until the test opens it.
  gate = new Promise((resolve) => {
    release = resolve;
  });
};

it('answers the result of a call that ends within the wait, and the task of one that does not', async () => {
  const prefer = { prefer: 'respond-async' };
  expect((await call('POST', '/v1/reports', { slow: false }, prefer)).body.data).toEqual({ rows: 3 });
  slowly();
  const started = await call('POST', '/v1/reports', { slow: true }, prefer);
  expect(started.status).toBe(202);
  expect(started.headers.get('preference-applied')).toBe('respond-async');
  const { taskId } = started.body.data;
  expect(taskId).toMatch(/^jobs\.[0-9a-f-]{36}$/);
  expect(started.headers.get('location')).toBe(`https://jobs.example.test/v1/tasks/${taskId}`);
  expect(started.body.data).toMatchObject({ status: 'working', ttlMs: 3_600_000, pollIntervalMs: 2000 });
  // Someone else in the organization does not find it, nor may cancel it.
  expect((await call('GET', `/v1/tasks/${taskId}`, undefined, {}, 'other')).body.error).toMatchObject({
    code: 'INVALID_INPUT',
    data: { issues: [{ path: '/taskId' }] },
  });
  // Cancelling a task that has started running leaves it to run to its end.
  expect((await call('POST', `/v1/tasks/${taskId}/cancel`, {})).body.data.status).toBe('working');
  release();
  await delay(10);
  expect((await call('GET', `/v1/tasks/${taskId}`)).body.data).toMatchObject({
    status: 'completed',
    result: { rows: 3 },
  });
  // Without the preference, the call answers its result, however long it takes.
  expect((await call('POST', '/v1/reports', { slow: false })).status).toBe(200);
});

it('answers a task to an MCP client that declares the extension, which tasks/get reads and only its caller', async () => {
  const initialized = await modern('server/discover', {}, '');
  expect(initialized.result.capabilities.extensions).toHaveProperty(TASKS_EXTENSION_ID_V2);
  slowly();
  const answered = (
    await modern('tools/call', { name: 'run_report', arguments: { slow: true } }, 'run_report')
  ).result;
  expect(answered).toMatchObject({ resultType: 'task', status: 'working' });
  expect(isCreateTaskResultV2(answered)).toBe(true);
  const read = (sub?: string) => modern('tasks/get', { taskId: answered.taskId }, answered.taskId, sub);
  expect((await read()).result).toMatchObject({ resultType: 'complete', status: 'working' });
  // A task this caller did not start is invalid params, as an unknown one is.
  expect((await read('other')).error.code).toBe(-32_602);
  expect((await modern('tasks/get', { taskId: 'jobs.unknown' }, 'jobs.unknown')).error.code).toBe(-32_602);
  release();
  await delay(10);
  const completed = (await read()).result;
  expect(isDetailedTaskV2(completed)).toBe(true);
  expect(completed).toMatchObject({
    status: 'completed',
    result: { structuredContent: { rows: 3 }, content: [{ type: 'text', text: '{"rows":3}' }] },
  });
});

it('settles a task it finds started but unfinished as OUTCOME_UNKNOWN, and never runs it again', async () => {
  const store = (env.MAXIMUS_TASKS as ReturnType<typeof namespace>).get('org_1234567890abcdef');
  const principal = {
    actorId: 'person',
    actorKind: 'service',
    organizationId: 'org_1234567890abcdef',
    requestId: crypto.randomUUID(),
  };
  const interrupted: TaskRecord = {
    taskId: 'jobs.interrupted',
    operation: 'runReport',
    input: { slow: false },
    principal,
    status: 'working',
    started: true,
    createdAt: Date.now(),
    lastUpdatedAt: Date.now(),
  } as TaskRecord;
  const before = runs;
  const settled = await store.run(interrupted, 1000);
  expect(runs).toBe(before);
  expect(settled).toMatchObject({
    status: 'failed',
    result: { ok: false, error: { code: 'OUTCOME_UNKNOWN' } },
  });
});
