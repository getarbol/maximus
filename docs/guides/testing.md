# Testing

Maximus tests its own guarantees: token verification, routing, envelopes, validation boundaries,
privacy of diagnostics and MCP pagination. Your tests cover what only your service knows: its domain
rules, tenant isolation in its queries, its provider projections, its state and its policies. This
guide shows the tools for each layer.

## Keep the application importable

Put the application in a module that does not import `cloudflare:workers` (`app.ts`), and create the
Worker in another (`index.ts`). Tests, scripts and the `maximus` CLI can then import the application
and run it in Node or Bun.

## Run operations through the HTTP handler

`createHttpHandler(app)` is the same handler `createWorker` serves. Call it with a `Request` and an
environment:

```ts
import { createHttpHandler } from '@arbol-ai/maximus';
import { expect, it } from 'vitest';

import { app } from '../src/app';

const env = { NOTES: memoryStore(), DEVELOPMENT_TOKEN: 'local-development-token-for-tests-only' };
const handle = createHttpHandler(app);

it('refuses a request without a valid token', async () => {
  const response = await handle(new Request('http://localhost:5173/v1/notes'), env);
  expect(response.status).toBe(401);
});
```

Fake bindings through the narrow interfaces your application declares (a `NoteStore` with `get`,
`put` and `list`), not through casts of the platform's types. The complete test is
[`examples/minimal-http/tests/notes.test.ts`](../../examples/minimal-http/tests/notes.test.ts).

### Authenticating in tests

- **With a custom `tokens.resolve`**, exercise it as production does: put the test credential in the
  environment, as the example does with its development token.
- **With the default OAuth verification**, pass `verify` to replace only the JWT check. The claims
  you return still go through the normal mapping and scope checks:

  ```ts
  const person = {
    sub: 'person-1',
    azp: 'notes-web',
    org_id: 'org_1234567890abcdef',
    scope: 'notes:notes:read notes:notes:write',
    permissions: ['notes:notes:read', 'notes:notes:write'],
  };
  const handle = createHttpHandler(app, { verify: async () => person });

  await handle(
    new Request('https://notes.example.com/v1/notes', { headers: { authorization: 'Bearer a.b.c' } }),
    env
  );
  ```

  The token must still look like a JWT (`a.b.c`). A machine is `sub: '<client>@clients'` with
  `client_id: '<client>'` and no `permissions`. `verify` is a test seam: never pass it in a deployed
  Worker.

### The typed client in tests

Give the client the handler as its `fetch`, and assert on typed data:

```ts
const notes = createClient<typeof app>('http://localhost:5173', token, {
  response: 'data',
  fetch: async (input, init) => await handle(new Request(input, init), env),
});

const created = await notes.createNote({ text: 'Buy coffee' });
expect(await notes.getNote({ noteId: created.noteId })).toEqual(created);
```

### MCP

Mount the transport on the test handler and post JSON-RPC. Responses are server-sent events:

```ts
import { mcp } from '@arbol-ai/maximus/mcp';

const handle = createHttpHandler(app, { verify: async () => person, transports: [mcp()] });

async function rpc(method: string, params: object = {}) {
  const response = await handle(
    new Request('https://tasks.example.com/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer a.b.c',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
    env
  );
  const text = await response.text();
  return JSON.parse(/data: (\{[^\n]*)/u.exec(text)?.[1] ?? text);
}

expect((await rpc('tools/list')).result.tools.map((tool: { name: string }) => tool.name)).toContain(
  'list_tasks'
);
```

## Operations without HTTP

An RPC-only operation has no route. `executeOperation` from `@arbol-ai/maximus/internals`
runs the shared execution path directly, the same one every transport uses:

```ts
import { executeOperation } from '@arbol-ai/maximus/internals';

const principal = {
  actorId: 'orders',
  actorKind: 'service' as const,
  organizationId: 'org_1234567890abcdef',
  requestId: crypto.randomUUID(),
};
const result = await executeOperation(app, app.operations.quoteItems, env, principal, {
  items: [{ sku: 'TEA-001', quantity: 2 }],
});
```

A sixth argument passes token authority (`{ surface, scopes, client }`), for operations with
conditional scopes. Transport checks (props, proof verification) are not part of this path; the
framework tests those.

## A contract smoke

`verifyContract(fetch, origin)` from `@arbol-ai/maximus/testing` fetches `/openapi.json` and
`/openapi.yaml` through the fetch you give it, checks that they are the same document, and returns
`{ paths, operations }`:

```ts
import { verifyContract } from '@arbol-ai/maximus/testing';

const { operations } = await verifyContract((request) => handle(request, env), 'https://notes.example.com');
expect(operations).toEqual(['createNote', 'listNotes', 'getNote']);
```

Run one smoke per service against the real Worker: inside workerd, or against a deployment.

## Inside workerd

For Durable Objects, real bindings and Service Bindings, run tests in workerd with Cloudflare's
[Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/), with
remote bindings off. Two Workers that talk over RPC can also be started together with Miniflare and
called through their bindings; the framework's own native RPC test does this.

## Native RPC types

`Service<typeof Entrypoint>` turns a method whose signature cannot cross RPC into `never`, silently.
Guard each method you depend on with a type check and a negative control:

```ts
import type { PricingService } from '../../pricing/src/index';

type AssertFalse<T extends false> = T;
type IsNever<T> = [T] extends [never] ? true : false;

export type QuoteReturnExists = AssertFalse<
  IsNever<Awaited<ReturnType<Service<typeof PricingService>['quoteItems']>>>
>;
// @ts-expect-error The control must fail; otherwise the check above proves nothing.
export type NeverControl = AssertFalse<IsNever<never>>;
```

## Rules for CI

- Use synthetic data. Never use real customer records, live provider accounts or paid services in
  CI.
- Keep remote bindings off, and never point tests at production resources.
- Scripts call your domain functions or the typed client; they never reimplement a provider
  protocol.
- Keep tests in the package that owns the behavior, and keep the security, privacy and retry tests
  you have.
