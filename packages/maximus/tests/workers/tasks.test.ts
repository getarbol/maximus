/**
 * Tasks: an operation that declares `task` answers a task once its call outlasts the wait, over HTTP to
 * `Prefer: respond-async` and over MCP to a client that declares the Tasks extension. Each task has its own
 * object, so tasks run side by side; the store runs each once, as the official guards read it, keeps it for
 * its caller alone and for its TTL, never stores its input, and settles a task an interruption left started
 * as OUTCOME_UNKNOWN.
 */
import {
  hasTaskClientCapabilityV2,
  isCreateTaskResultV2,
  isDetailedTaskV2,
  TASKS_EXTENSION_ID_V2,
} from '@modelcontextprotocol/ext-tasks/core/v2';
import { expect, it } from 'vite-plus/test';

import { createHttpHandler, defineErrors, maximus, ok, t } from '../../src/index.ts';
import { delay } from '../../src/internal/delay.ts';
import { mcp } from '../../src/mcp/index.ts';
import { declaresTasks, isTaskResult } from '../../src/mcp/tasks.ts';
import { taskTtl } from '../../src/tasks.ts';
import type { TaskRecord } from '../../src/tasks.ts';
import { tasksObject } from '../../src/workers/tasks.ts';

const strict = { additionalProperties: false } as const;
/** Releases the slow calls that are waiting. */
let release = () => {};
let gate = Promise.resolve();
/** Holds every alarm until it opens. */
let alarmGate = Promise.resolve();
let runs = 0;
let running = 0;
let concurrent = 0;
/** The task each run ran as. */
const taskIds: (string | undefined)[] = [];
/** Whether storage refuses to keep a value, as it refuses one over its size limit. */
let refuse = (_value: unknown) => false;
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
      task: { ttlMs: 900_000 },
    },
    async ({ taskId }, { slow }) => {
      runs += 1;
      taskIds.push(taskId);
      running += 1;
      concurrent = Math.max(concurrent, running);
      if (slow) {
        await gate;
      }
      running -= 1;
      return ok({ rows: 3 });
    }
  )
  .build();

/**
 * Durable Objects in memory, one per name, each with its own storage. Alarms run as the platform runs them:
 * when due, and once more when one throws. `restart` gives an object a new instance over the same storage.
 */
function namespace(env: Record<string, unknown>) {
  const Store = tasksObject(app);
  const named: string[] = [];
  const objects = new Map<string, InstanceType<typeof Store>>();
  const storages = new Map<string, Map<string, unknown>>();
  const create = (id: string) => {
    const data = storages.get(id) ?? new Map<string, unknown>();
    storages.set(id, data);
    let alarms = Promise.resolve();
    const storage = {
      get: async (name: string) => structuredClone(data.get(name)),
      put: async (name: string, value: unknown) => {
        if (refuse(value)) {
          throw new RangeError('Value too large');
        }
        data.set(name, structuredClone(value));
      },
      deleteAll: async () => data.clear(),
      setAlarm: async (time: number) => {
        if (time <= Date.now()) {
          const ring = () => created.alarm?.();
          const held = alarmGate;
          alarms = alarms
            .then(() => held)
            .then(ring)
            .catch(ring);
        }
      },
    };
    const created = new Store({ storage } as never, env);
    objects.set(id, created);
    return created;
  };
  return {
    named,
    idFromName: (name: string) => {
      named.push(name);
      return name;
    },
    get: (id: string) => objects.get(id) ?? create(id),
    restart: (id: string) => create(id),
  };
}
const env: Record<string, unknown> = {};
const tasks = namespace(env);
env.MAXIMUS_TASKS = tasks;
/** A token of `person`, or of anyone else in the same organization. */
const claims = (sub = 'person') => ({
  sub: `${sub}@clients`,
  client_id: sub,
  org_id: 'org_1234567890abcdef',
  scope: 'jobs:reports:write jobs:mcp:use',
});
const handler = (sub?: string) =>
  createHttpHandler(app, { transports: [mcp()], verify: async () => claims(sub) });
const prefer = { prefer: 'respond-async' };

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
/** The `_meta` of a 2026-07-28 request that declares the Tasks extension. */
const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': { extensions: { [TASKS_EXTENSION_ID_V2]: {} } },
};
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
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } }),
    }),
    env
  );
  return JSON.parse(await response.text());
}
/** Closes the gate a slow call waits at, until `release`. */
const slowly = () => {
  // oxlint-disable-next-line promise/avoid-new -- A slow call waits at this gate until the test opens it.
  gate = new Promise((resolve) => {
    release = resolve;
  });
};

it('answers the result of a call that ends within the wait, and the task of one that does not', async () => {
  expect((await call('POST', '/v1/reports', { slow: false }, prefer)).body.data).toEqual({ rows: 3 });
  slowly();
  const started = await call('POST', '/v1/reports', { slow: true }, prefer);
  expect(started.status).toBe(202);
  expect(started.headers.get('preference-applied')).toBe('respond-async');
  const { taskId } = started.body.data;
  expect(taskId).toMatch(/^jobs\.[0-9a-f-]{36}$/);
  expect(started.headers.get('location')).toBe(`https://jobs.example.test/v1/operation-tasks/${taskId}`);
  expect(started.body.data).toMatchObject({ status: 'working', ttlMs: 900_000, pollIntervalMs: 2000 });
  // The handler knows the task it runs as.
  expect(taskIds.at(-1)).toBe(taskId);
  // Someone else in the organization does not find it, nor may cancel it; an id never issued reaches no object.
  const named = tasks.named.length;
  for (const [path, sub] of [
    [`/v1/operation-tasks/${taskId}`, 'other'],
    ['/v1/operation-tasks/jobs.not-a-uuid', undefined],
    [`/v1/operation-tasks/notes.${crypto.randomUUID()}`, undefined],
  ] as const) {
    expect((await call('GET', path, undefined, {}, sub)).body.error).toMatchObject({
      code: 'INVALID_INPUT',
      data: { issues: [{ path: '/taskId' }] },
    });
  }
  expect(tasks.named.length).toBe(named + 1);
  // Cancelling a task that has started running leaves it to run to its end.
  expect((await call('POST', `/v1/operation-tasks/${taskId}/cancel`, {})).body.data.status).toBe('working');
  release();
  await delay(10);
  expect((await call('GET', `/v1/operation-tasks/${taskId}`)).body.data).toMatchObject({
    status: 'completed',
    result: { rows: 3 },
  });
  // Without the preference, the call answers its result, however long it takes, and runs as no task.
  expect((await call('POST', '/v1/reports', { slow: false })).status).toBe(200);
  expect(taskIds.at(-1)).toBeUndefined();
});

it("runs an organization's tasks side by side, each in its own object", async () => {
  slowly();
  running = 0;
  concurrent = 0;
  const [first, second] = await Promise.all([
    call('POST', '/v1/reports', { slow: true }, prefer),
    call('POST', '/v1/reports', { slow: true }, prefer),
  ]);
  expect([first?.status, second?.status]).toEqual([202, 202]);
  expect(concurrent).toBe(2);
  release();
  await delay(10);
  for (const { body } of [first, second]) {
    expect((await call('GET', `/v1/operation-tasks/${body.data.taskId}`)).body.data.status).toBe('completed');
  }
});

it('cancels a task that has not started, which then never runs', async () => {
  // oxlint-disable-next-line promise/avoid-new -- The alarms wait at this gate until the test opens it.
  alarmGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const before = runs;
  const started = await call('POST', '/v1/reports', { slow: false }, prefer);
  const { taskId } = started.body.data;
  expect(started.body.data.status).toBe('working');
  expect((await call('POST', `/v1/operation-tasks/${taskId}/cancel`, {})).body.data.status).toBe('cancelled');
  release();
  alarmGate = Promise.resolve();
  await delay(10);
  expect(runs).toBe(before);
  expect((await call('GET', `/v1/operation-tasks/${taskId}`)).body.data.status).toBe('cancelled');
});

it('answers a task to an MCP client that declares the extension, which tasks/get reads and only its caller', async () => {
  const initialized = await modern('server/discover', {}, '');
  expect(initialized.result.capabilities.extensions).toHaveProperty(TASKS_EXTENSION_ID_V2);
  slowly();
  const answered = (
    await modern('tools/call', { name: 'run_report', arguments: { slow: true } }, 'run_report')
  ).result;
  expect(answered).toMatchObject({ resultType: 'task', status: 'working', ttlMs: 900_000 });
  expect(isCreateTaskResultV2(answered)).toBe(true);
  expect(isTaskResult(answered)).toBe(true);
  const read = (sub?: string) => modern('tasks/get', { taskId: answered.taskId }, answered.taskId, sub);
  expect((await read()).result).toMatchObject({ resultType: 'complete', status: 'working' });
  // A task this caller did not start is invalid params, as an unknown one is.
  expect((await read('other')).error.code).toBe(-32_602);
  expect((await modern('tasks/get', { taskId: 'jobs.unknown' }, 'jobs.unknown')).error.code).toBe(-32_602);
  release();
  await delay(10);
  const completed = (await read()).result;
  expect(isDetailedTaskV2(completed)).toBe(true);
  expect(isTaskResult(completed)).toBe(false);
  expect(completed).toMatchObject({
    status: 'completed',
    result: { structuredContent: { rows: 3 }, content: [{ type: 'text', text: '{"rows":3}' }] },
  });
});

it("reads a client's declaration of the extension as the official guard does", () => {
  for (const declared of [
    meta,
    { 'io.modelcontextprotocol/clientCapabilities': { extensions: {} } },
    { 'io.modelcontextprotocol/clientCapabilities': { extensions: { [TASKS_EXTENSION_ID_V2]: { a: 1 } } } },
    { 'io.modelcontextprotocol/clientCapabilities': { extensions: { [TASKS_EXTENSION_ID_V2]: null } } },
    { 'io.modelcontextprotocol/clientCapabilities': [] },
    null,
    undefined,
  ]) {
    expect(declaresTasks(declared)).toBe(hasTaskClientCapabilityV2({ _meta: declared }));
  }
});

/** A task of `person` as the store keeps it, created `age` milliseconds ago. */
const record = (taskId: string, fields: Partial<TaskRecord> = {}, age = 0): TaskRecord => ({
  taskId,
  operation: 'runReport',
  principal: {
    actorId: 'person',
    actorKind: 'service',
    organizationId: 'org_1234567890abcdef',
    requestId: crypto.randomUUID(),
  },
  status: 'working',
  started: false,
  createdAt: Date.now() - age,
  lastUpdatedAt: Date.now() - age,
  ttlMs: 900_000,
  ...fields,
});

it('settles a task it finds started but unfinished as OUTCOME_UNKNOWN, and never runs it again', async () => {
  const before = runs;
  const settled = await tasks
    .get('jobs.interrupted')
    .run(record('jobs.interrupted', { started: true }), {}, 1000);
  expect(runs).toBe(before);
  expect(settled).toMatchObject({
    status: 'failed',
    result: { ok: false, error: { code: 'OUTCOME_UNKNOWN' } },
  });
});

it('never stores the input, so a task whose object restarted before it started fails without running', async () => {
  const before = runs;
  // oxlint-disable-next-line promise/avoid-new -- The first instance's alarm never comes: it restarts first.
  alarmGate = new Promise(() => {
    // Never resolved.
  });
  const waiting = await tasks.get('jobs.restarted').run(record('jobs.restarted'), { slow: false }, 0);
  expect(JSON.stringify(waiting)).not.toContain('slow');
  alarmGate = Promise.resolve();
  await tasks.restart('jobs.restarted').alarm?.();
  expect(runs).toBe(before);
  expect(await tasks.get('jobs.restarted').get('jobs.restarted', record('').principal)).toMatchObject({
    status: 'failed',
    result: { ok: false, error: { code: 'INTERNAL_ERROR' } },
  });
});

it('keeps a task for its TTL, an hour by default, then answers none and deletes it', async () => {
  expect([taskTtl({ task: true }), taskTtl({ task: { ttlMs: 900_000 } })]).toEqual([3_600_000, 900_000]);
  const before = runs;
  const store = tasks.get('jobs.expired');
  await store.run(record('jobs.expired', {}, 900_001), { slow: false }, 0);
  await delay(10);
  expect(await store.get('jobs.expired', record('').principal)).toBeUndefined();
  expect(runs).toBe(before);
});

it('settles a task whose result storage refused as OUTCOME_UNKNOWN, without running it again', async () => {
  refuse = (value) => (value as TaskRecord).status === 'completed';
  const before = runs;
  const answered = await call('POST', '/v1/reports', { slow: false }, prefer);
  refuse = () => false;
  expect(answered.status).toBe(502);
  expect(answered.body.error.code).toBe('OUTCOME_UNKNOWN');
  expect(runs).toBe(before + 1);
});
