# Testing

A project tests itself in Node with `vp test`: each test calls the API as the Worker serves it, over
stand-ins for the bindings it uses. This guide covers those tests, calls over MCP, the type tests that keep
an RPC contract in step with its routes, the contract check, and suites that call a running Worker.

## Run the tests

| Command             | Runs                                                                            |
| ------------------- | ------------------------------------------------------------------------------- |
| `bun run test`      | `vp test run`: every test file once, in Node.                                   |
| `bun run typecheck` | `maximus prepare`, then `tsc`: the project's types, the type tests among them.  |
| `bun run verify`    | The types, lint and format, the tests and the build, in that order. CI runs it. |

Tests live in `tests/`, in files that end in `.test.ts`. `vp test` reads `vite.config.ts`, and `maximus()`
prepares the project as `vp dev` does before any test runs: it writes `.maximus/` for development. Under
Vitest, `maximus()` leaves Cloudflare's plugin out, so the tests run in Node rather than in workerd, against
the bindings each test passes in.

## Call the API

`handler`, from `#maximus/http`, is the API as the Worker serves it: below its base path, `/api` by
default, behind the request middleware of `middleware/`, with `/health`, the OpenAPI document, OAuth
discovery and, when the project serves MCP, `/mcp`. It is generated in `.maximus/http.ts`, and the
starter's `package.json` maps `#maximus/*` to `.maximus/` in its `imports`. A test calls it with a
`Request` and an `env` of its own:

```ts
// tests/notes.test.ts
import { beforeEach, expect, it } from 'vite-plus/test';

import { handler } from '#maximus/http';

import { noteStore } from '../src/notes.ts';
import type { Note } from '../src/notes.ts';
import { testNamespace } from './kv.ts';

/** The development token `vp test` accepts from localhost, as a developer who holds every scope. */
const token = 'test-development-token-for-local-tests';
let env: Env;

beforeEach(() => {
  env = { DEVELOPMENT_TOKEN: token, NOTES: testNamespace() } as Env;
});

/** Calls the API as the Worker serves it, with the development token, sending `body` as JSON. */
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

it('writes a note and reads it back', async () => {
  const created = await call('POST', '/v1/notes', { text: 'Call back on Monday.' });
  expect(created).toMatchObject({ status: 201, body: { data: { text: 'Call back on Monday.' } } });
  const note = created.body.data as Note;
  expect((await call('GET', `/v1/notes/${note.noteId}`)).body.data).toEqual(note);
});

it('refuses an empty note, and a caller without a token', async () => {
  expect(await call('POST', '/v1/notes', { text: '' })).toMatchObject({
    status: 400,
    body: { error: { code: 'INVALID_INPUT' } },
  });
  const anonymous = await handler(new Request(`http://localhost/api/v1/notes/${crypto.randomUUID()}`), env);
  expect(anonymous.status).toBe(401);
});

it('keeps each organization to its own notes', async () => {
  const kv = testNamespace();
  const note = await noteStore(kv, 'org_1234567890abcdef').create('Call back on Monday.');
  expect(await noteStore(kv, 'org_abcdef1234567890').get(note.noteId)).toBeUndefined();
});
```

Every call runs the whole path a deployed call runs: admission of the token and its scope, the input
check, `context.ts`, the handler and the output check. A route that answers an output its schema refuses
answers `INTERNAL_ERROR` here as it would in production.

The development token signs these calls in. Because `vp test` prepares the development build, the
application accepts the token that `env.DEVELOPMENT_TOKEN` holds, when it has at least 32 characters and the
request's host is `localhost`, `127.0.0.1` or `[::1]`. The caller is the developer `local-developer` of
the organization `local-development`, holding every scope the service defines.
[Authentication and scopes](authentication-and-scopes.md) describes the token; a production build has
neither its binding nor the policy that accepts it.

Every call through the API acts for that one organization. Test that one organization never reaches
another's data through the store itself, with two organization ids, as the last test does.

`handler` serves the API alone. A page of `pages/` or a web app's files are answered by the Worker that
`vp dev` runs, not by `handler`.

## Stand in for bindings

A stand-in implements the methods your code calls and nothing else, and is cast once to the binding's
type. Create a new one for each test, in `beforeEach`, so no test sees another's data. The code under test,
the store and its queries, stays the code the Worker runs.

Workers KV is a `Map` behind `get` and `put`:

```ts
// tests/kv.ts
/** Workers KV for tests: a Map behind the methods the notes use. Each call answers a new, empty namespace. */
export function testNamespace(): KVNamespace {
  const values = new Map<string, string>();
  const namespace = {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
  // The notes use get and put alone: what KVNamespace declares besides goes unused.
  return namespace as unknown as KVNamespace;
}
```

D1 is Node's SQLite in memory, with the project's own migrations applied in the order
`cf d1 migrations apply` applies them, so the tests run the same schema as the database:

```ts
// tests/d1.ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';

/** The project's migrations, in the order `cf d1 migrations apply` applies them. */
const MIGRATIONS = join(import.meta.dirname, '../migrations');

/** A new in-memory database with every migration applied. */
export function testDatabase(): D1Database {
  const database = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .toSorted()) {
    database.exec(readFileSync(join(MIGRATIONS, file), 'utf-8'));
  }
  /** A statement with the values bound so far. */
  const statement = (sql: string, values: readonly SQLInputValue[] = []) => ({
    bind: (...bound: SQLInputValue[]) => statement(sql, bound),
    first: async () => database.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: database.prepare(sql).all(...values), success: true, meta: {} }),
    run: async () => {
      const { changes } = database.prepare(sql).run(...values);
      return { results: [], success: true, meta: { changes: Number(changes) } };
    },
  });
  // The notes use prepare, bind, first, all and run alone: what D1Database declares besides goes unused.
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}
```

The examples stand in for the other bindings the same way:

- **R2**: a `Map` of objects behind `put`, `head`, `get` and `delete`, which refuses an upload whose
  SHA-256 does not match, as R2 does. See
  [`examples/r2-documents/tests/r2.ts`](../../examples/r2-documents/tests/r2.ts).
- **Queues**: a producer that records each message `send` and `sendBatch` receive, and a batch whose
  messages record whether the consumer called `ack()` or `retry()`. A test calls the queue module's default
  export, and a cron module's, directly with the event, the `env` and an execution context. See
  [`examples/queue-reminders/tests`](../../examples/queue-reminders/tests).
- **Another Worker over RPC**: an object with the methods the binding exposes, each a `vi.fn()` typed by
  the owner's contract, so a test controls what the other Worker answers. See
  [`examples/worker-rpc/orders/tests`](../../examples/worker-rpc/orders/tests).

## Durable Objects and `cloudflare:workers`

Under Vitest, `maximus()` resolves `cloudflare:workers` to a stand-in that `@arbol-ai/maximus/vite` ships:

| Export             | In the stand-in                                                     |
| ------------------ | ------------------------------------------------------------------- |
| `WorkerEntrypoint` | A base class that keeps the `ctx` and `env` it is constructed with. |
| `DurableObject`    | A base class that keeps the `ctx` and `env` it is constructed with. |
| `RpcTarget`        | An empty base class.                                                |
| `tracing`          | No active span.                                                     |

Whatever else a class needs of the platform, the test passes in its `ctx` and `env`. A Durable Object class
of `durable-objects/` therefore constructs in Node. Take one that counts an organization's notes in its SQL
storage, exported with `exports: { NoteCounter: exports.durableObject({ storage: 'sqlite' }) }` and bound as
`COUNTERS: bindings.durableObject({ worker: 'notes', exportName: 'NoteCounter' })` in `maximus()`:

```ts
// durable-objects/note-counter.ts
import { DurableObject } from 'cloudflare:workers';

/** One organization's count of the notes it wrote, one call at a time. */
export default class NoteCounter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS counter (total INTEGER NOT NULL)');
  }

  /** Counts one more note and answers the total. */
  increment(): number {
    const [row] = this.ctx.storage.sql.exec<{ total: number }>('SELECT total FROM counter').toArray();
    const total = (row?.total ?? 0) + 1;
    this.ctx.storage.sql.exec(
      row ? 'UPDATE counter SET total = ?' : 'INSERT INTO counter (total) VALUES (?)',
      total
    );
    return total;
  }
}
```

A namespace stand-in creates one instance per name, whose SQL storage is Node's SQLite:

```ts
// tests/durable-objects.ts
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';

/** SQL storage over a new in-memory database: `exec` answers the rows a query reads, or how many it wrote. */
function sqlStorage() {
  const database = new DatabaseSync(':memory:');
  return {
    exec(query: string, ...bindings: SQLInputValue[]) {
      const statement = database.prepare(query);
      if (statement.columns().length > 0) {
        const rows = statement.all(...bindings);
        return { toArray: () => rows, rowsWritten: 0 };
      }
      const { changes } = statement.run(...bindings);
      return { toArray: () => [], rowsWritten: Number(changes) };
    },
  };
}

/** A Durable Object namespace whose instances `create` constructs, one per name, called directly. */
export function testNamespace<T>(create: (state: DurableObjectState) => T) {
  const instances = new Map<string, T>();
  return {
    getByName(name: string): T {
      let instance = instances.get(name);
      if (!instance) {
        // The class uses storage.sql alone: what DurableObjectState declares besides goes unused.
        instance = create({ storage: { sql: sqlStorage() } } as unknown as DurableObjectState);
        instances.set(name, instance);
      }
      return instance;
    },
  };
}
```

A route that calls `env.COUNTERS.getByName(principal.organizationId).increment()` reaches the instance of
the caller's organization, and the test reaches any instance by its name:

```ts
// tests/counter.test.ts
import { beforeEach, expect, it } from 'vite-plus/test';

import { handler } from '#maximus/http';

import NoteCounter from '../durable-objects/note-counter.ts';
import { testNamespace } from './durable-objects.ts';

const token = 'test-development-token-for-local-tests';
let counters: ReturnType<typeof testNamespace<NoteCounter>>;
let env: Env;

beforeEach(() => {
  counters = testNamespace((state) => new NoteCounter(state, env));
  env = { DEVELOPMENT_TOKEN: token, COUNTERS: counters } as unknown as Env;
});

it('counts the notes of the caller’s organization in its own object', async () => {
  const count = async () => {
    const response = await handler(
      new Request('http://localhost/api/v1/counter', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
      }),
      env
    );
    return ((await response.json()) as { data: { total: number } }).data.total;
  };
  expect([await count(), await count()]).toEqual([1, 2]);
  expect(counters.getByName('local-development').increment()).toBe(3);
  expect(counters.getByName('org_1234567890abcdef').increment()).toBe(1);
});
```

Cloudflare delivers calls to one object one at a time; the stand-in calls its methods directly, in the
order the test makes them. [`examples/do-appointments/tests`](../../examples/do-appointments/tests) shows
two callers asking for the same slot at once. [Durable Objects](durable-objects.md) covers the classes.

## Call MCP

The MCP server is `/mcp` on the same `handler`. A test posts a JSON-RPC message that accepts both JSON and
server-sent events, and reads the answer from its `data:` line. Added to `tests/notes.test.ts`, beside
`call`:

```ts
/** Sends one JSON-RPC request to the MCP server, signed in, and answers its result. */
async function mcp(method: string, params: object = {}) {
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
  // The answer is a server-sent event whose `data:` line holds the JSON-RPC message.
  const text = await response.text();
  const message = JSON.parse(/data: (\{[^\n]*)/u.exec(text)?.[1] ?? text) as {
    result: Record<string, unknown>;
  };
  return message.result;
}

it('serves get_note to agents, with the route’s checks', async () => {
  const note = (await call('POST', '/v1/notes', { text: 'Call back on Monday.' })).body.data as Note;
  const tools = (await mcp('tools/list')).tools as { name: string }[];
  expect(tools.map(({ name }) => name)).toContain('get_note');
  expect(await mcp('tools/call', { name: 'get_note', arguments: { noteId: note.noteId } })).toMatchObject({
    structuredContent: note,
  });
  expect(
    await mcp('tools/call', { name: 'get_note', arguments: { noteId: crypto.randomUUID() } })
  ).toMatchObject({ isError: true });
});
```

A tool's output is the result's `structuredContent`; a failure is a result with `isError: true` whose text
is the failure, `NOTE_NOT_FOUND` here. `tools/list` lists the tools the caller's scopes admit, and the
development token holds them all, `<service>:mcp:use` included. [MCP](mcp.md) describes the server.

## Check RPC types

A Worker that calls this one over RPC types its binding with a contract this project publishes: an
interface of the `Service` entrypoint's methods, in a file that imports no route (see
[Worker RPC](worker-rpc.md)). Here a route declares `operationId: 'summarizeNote'` and `rpc: true`, and
the contract states the method it serves:

```ts
// src/contract.ts: what the Workers that call this one import
import { t } from '@arbol-ai/maximus';
import type { Failure, Principal, Result, Static } from '@arbol-ai/maximus';
import type { WorkerEntrypoint } from 'cloudflare:workers';

/** A note's summary, as callers over RPC receive it. */
export const SummarySchema = t.Object(
  { noteId: t.String(), words: t.Integer({ minimum: 0 }) },
  { $id: 'Summary', additionalProperties: false }
);
export type Summary = Static<typeof SummarySchema>;

/** The `Service` entrypoint that other Workers bind. */
export interface NotesService extends WorkerEntrypoint {
  summarizeNote: (principal: Principal, input: { noteId: string }) => Promise<Result<Summary, Failure>>;
}
```

A type test proves the routes serve exactly that contract:

```ts
// tests/rpc.test.ts
import type { RpcMethods } from '@arbol-ai/maximus/workers';
import type { WorkerEntrypoint } from 'cloudflare:workers';
import { expectTypeOf, it } from 'vite-plus/test';

import type { app } from '#maximus/app';

import type { NotesService } from '../src/contract.ts';

it('serves over RPC exactly the methods its contract declares', () => {
  expectTypeOf<RpcMethods<typeof app.operations>>().toEqualTypeOf<
    Omit<NotesService, keyof WorkerEntrypoint>
  >();
  // @ts-expect-error A contract without summarizeNote is not the one the routes serve.
  expectTypeOf<RpcMethods<typeof app.operations>>().toEqualTypeOf<Record<never, never>>();
});
```

`RpcMethods<typeof app.operations>` is the type of the entrypoint's methods: one for each operation that
declares `rpc`, named by its operation, taking the caller's principal and the input and answering a
`Result`. `app` comes from `#maximus/app` as a type alone.

`tsc` checks these assertions, in `bun run typecheck` and so in `bun run verify`. `vp test run` runs the
file without checking its types, so a contract that drifted from its routes passes `bun run test` and fails
`bun run typecheck`. The `@ts-expect-error` line is the negative control: it proves the comparison can
fail, because a check that accepted any type would make that line compile, and `tsc` would report the
directive as unused.

## Check the published contract

`verifyContract`, from `@arbol-ai/maximus/testing`, reads a service's OpenAPI document the way a client
does. Given a `fetch` function and the API's origin, it:

1. Fetches `<origin>/openapi.json` and `<origin>/openapi.yaml`, without a token.
2. Throws `OpenAPI is unavailable.` when either answer's status is not a 2xx.
3. Throws `OpenAPI JSON/YAML differ.` when the YAML text is not the JSON document, as Maximus writes it in
   YAML.
4. Answers `{ paths, operations }`: the document's path templates, and the `operationId` of each operation,
   in the document's order.

It checks nothing else: compare the operations it answers with the ones you expect. The origin includes the
API's base path, so in Node it is `http://localhost/api`:

```ts
// tests/contract.test.ts
import { verifyContract } from '@arbol-ai/maximus/testing';
import { expect, it } from 'vite-plus/test';

import { handler } from '#maximus/http';

it('publishes one OpenAPI document, as JSON and YAML, with the operations its routes declare', async () => {
  const env = {} as Env;
  const { operations } = await verifyContract((request) => handler(request, env), 'http://localhost/api');
  expect(operations).toEqual(['getGreeting', 'createGreeting', 'createNote', 'getNote']);
});
```

Against a running Worker, pass the global `fetch` and its origin, `https://notes.example.com/api`.

## Run suites against a running Worker

Tests in Node prove the code. A suite that calls a running Worker proves the build: the Worker workerd runs,
its bindings and its configuration. Write it to read the Worker's origin from the environment, and to skip
itself without one, so `bun run test` keeps running in Node alone:

```ts
// tests/running.test.ts
import { verifyContract } from '@arbol-ai/maximus/testing';
import { describe, expect, it } from 'vite-plus/test';

/** The running Worker's origin, `vp dev`'s or a deployment's. Without one, the suite is skipped. */
const origin = process.env.WORKER_URL;

describe.runIf(origin)('the running Worker', () => {
  it('reports its health', async () => {
    expect((await fetch(`${origin}/health`)).status).toBe(200);
  });

  it('publishes its operations in one document, as JSON and YAML', async () => {
    const { operations } = await verifyContract(fetch, `${origin}/api`);
    expect(operations).toContain('getGreeting');
  });

  it('refuses a call without a token, naming its OAuth metadata', async () => {
    const refused = await fetch(`${origin}/api/v1/greeting`);
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toMatch(/^Bearer resource_metadata="https:/);
  });
});
```

Run it against `bun run dev` in another terminal, against `bun run preview`, which serves the production
build locally, or against a deployment:

```sh
WORKER_URL=http://localhost:5173 bun run test running
```

These checks hold for any caller. Under `vp dev`, a suite may also sign in with the development token in
`.dev.vars`. A production build, whether `vp preview` or a deployment, accepts no development token: a
signed-in check against it needs a real access token for a test organization, which stays out of the
repository and out of shared logs.

The Maximus repository runs its examples this way: [`e2e/`](../../e2e) starts each example under `vp dev`
on a port of its own, with its D1 migrations applied and a development token of its own, waits until its
`/health` answers, and runs the suites; with `E2E_TARGET=remote` it runs them against the Workers deployed
to Cloudflare, where they check what any caller sees.

## Keep tests synthetic

- Use synthetic data: organization ids such as `org_1234567890abcdef`, made-up notes, no customer records
  and no clinical data, in tests and in their fixtures.
- Keep credentials out of tests. The development token in a test is accepted from localhost by a
  development build alone; a real access token for a running suite comes from the environment.
- Point no test at production resources. Stand-ins keep the tests in Node; a running suite targets a
  development server, a preview or a deployment made for testing.
- A green suite over stand-ins says nothing about a deployment: check the deployed Worker itself, as
  [Deploying](deploying.md#check-the-deployment) describes.
