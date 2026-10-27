# Testing

Maximus tests its own guarantees: token verification, routing, envelopes, validation, the privacy of its
diagnostics. A project tests what only it knows: its routes' answers and refusals, its domain rules, that
one organization never reaches another's data, how it handles other services' failures, and its state.

## Run

- `bun run test`: `vp test run`, in Node. `vp test` prepares the project as `vp dev` does, and leaves
  Cloudflare's plugin out.
- `bun run typecheck`: `maximus prepare && tsc`, which checks the type tests; `vp test run` does not.
- `bun run verify`: types, lint and format, tests and the build.

## Call the API

`handler` from `#maximus/http` is the API as the Worker serves it: below `/api`, behind the request
middleware, with `/health`, OpenAPI, OAuth discovery and `/mcp`. Pages and a web app's files are not part
of it.

```ts
import { beforeEach, expect, it } from 'vite-plus/test';

import { handler } from '#maximus/http';

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
```

- The development token signs in when `env.DEVELOPMENT_TOKEN` holds it (32 characters at least) and the URL's
  host is `localhost`: the caller is `local-developer` of `local-development`, with every scope.
- Test each refusal by its status and `error.code`: `400 INVALID_INPUT`, `401` without a token, the route's
  own failures.
- Test tenant isolation through the store, with two organization ids:
  `noteStore(namespace, 'org_1234567890abcdef').find(noteId)` never reads what
  `noteStore(namespace, 'org_abcdef1234567890')` wrote.
- Calling `handler(request, env)` without a third argument records no observation; pass `{ waitUntil }` to
  test observers.

## Stand-ins for bindings

Implement the methods the code calls, cast once (`as unknown as KVNamespace`), and create a new stand-in in
`beforeEach`. The examples hold one of each kind, in their `tests/` folders: Workers KV over a `Map`
(`tasks`), D1 over `node:sqlite` with the project's migrations applied (`d1-notes`), R2 with SHA-256 checks
(`r2-documents`), a queue that records what it is sent and a batch that records `ack()` and `retry()`
(`queue-reminders`), a Durable Object namespace whose `getByName` constructs the class over `node:sqlite`
(`do-appointments`), and another Worker's binding as an object of `vi.fn()` methods typed by the module
`maximus prepare` writes from its RPC document (`worker-rpc/orders`). A queue or cron module is tested by
calling its default export with the event, `env` and an execution context.

Under Vitest, `maximus()` resolves `cloudflare:workers` to a stand-in: `WorkerEntrypoint` and
`DurableObject` keep the `ctx` and `env` they are constructed with, `RpcTarget` is an empty class and
`tracing` has no active span. A Durable Object class therefore constructs in Node:
`testNamespace((state) => new NoteCounter(state, env))`.

## MCP

```ts
/** Sends one JSON-RPC request to the MCP server, signed in, and answers its result. */
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
  // The answer is a server-sent event whose `data:` line holds the JSON-RPC message.
  const text = await response.text();
  const message = JSON.parse(/data: (\{[^\n]*)/u.exec(text)?.[1] ?? text) as {
    result: Record<string, unknown>;
  };
  return message.result;
}
```

A tool's output is `result.structuredContent`; a failure is a result with `isError: true` whose text is the
failure.

## RPC documents and bindings

An owner proves the RPC document it commits, the one its callers bind to, is the one its routes declare:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createRpcOpenApi } from '@arbol-ai/maximus';
import { expect, it } from 'vite-plus/test';

import { app } from '#maximus/app';

it('publishes the RPC document its callers bind to, current with its routes', () => {
  const published: unknown = JSON.parse(
    readFileSync(join(import.meta.dirname, '../openapi.rpc.json'), 'utf-8')
  );
  expect(published).toStrictEqual(createRpcOpenApi(app));
});
```

`bunx maximus openapi --check` proves the same in CI. A caller's tests stand in for the binding with an object
typed by the generated module, `{ quoteItems: vi.fn<PricingService['quoteItems']>() }` with `PricingService`
from `#maximus/services/pricing`; a compile-only file with `@ts-expect-error` lines proves a call the owner's
document does not allow fails `tsc`.

## The contract check

`verifyContract(fetch, origin)` from `@arbol-ai/maximus/testing` fetches `<origin>/openapi.json` and
`<origin>/openapi.yaml` without a token, throws `OpenAPI is unavailable.` when either is not a 2xx and
`OpenAPI JSON/YAML differ.` when the YAML is not the same document, and answers `{ paths, operations }`:
the path templates and the `operationId`s, in the document's order. The origin includes the base path:
`verifyContract((request) => handler(request, env), 'http://localhost/api')`.

## Against a running Worker

A suite that reads the Worker's origin from the environment, and skips without one, checks a running Worker:
`vp dev`, `vp preview` (the production build) or a deployment. `/health` answers `200`, `verifyContract`
passes, and a call without a token answers `401` with `www-authenticate: Bearer resource_metadata="…"`. A
production build accepts no development token: a signed-in check needs a real access token for a test
organization, kept out of the repository.

```sh
WORKER_URL=http://localhost:5173 bun run test running
```

## Rules

Synthetic data only, such as `org_1234567890abcdef`: no customer records, no clinical data, no real
credentials. No test reaches production resources. A green suite over stand-ins is no evidence that a
deployment works: check the deployed Worker.

See [Testing](https://github.com/getarbol/maximus/blob/main/docs/guides/testing.md).
