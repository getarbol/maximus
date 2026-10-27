# Testing

Maximus tests its own guarantees (token verification, routing, envelopes, validation boundaries,
diagnostics privacy, MCP pagination). Test what only the service knows: domain rules, tenant
isolation in queries, provider projections, state, retries and policies. Do not copy the framework's
matrices into every service.

## Handler tests (Node or Bun, Vitest)

```ts
import { createHttpHandler } from '@arbol-ai/maximus';
import { app } from '../src/app'; // app.ts must not import cloudflare:workers

const handle = createHttpHandler(app);
const response = await handle(new Request('http://localhost:5173/v1/notes'), env);
```

- Fake bindings through the narrow interfaces in `Env` (a `Map` behind a `NoteStore`), not casts.
- Default OAuth verification: `createHttpHandler(app, { verify: async () => claims })` replaces only
  the JWT check. Person claims: `{ sub, azp, org_id: 'org_1234567890abcdef', scope, permissions }`;
  machine: `{ sub: '<client>@clients', client_id: '<client>', org_id, scope }`. Send
  `authorization: Bearer a.b.c` (JWT-shaped). Never pass `verify` in production.
- Custom `tokens.resolve`: put the test credential in `env` and exercise the real resolver.
- Call the handler directly: `await handle(new Request('http://localhost:5173/v1/notes', init), env)`, and
  read the envelope.

## MCP

```ts
const handle = createHttpHandler(app, { verify: async () => claims, transports: [mcp()] });
// POST /mcp with accept: application/json, text/event-stream and a JSON-RPC body;
// parse the response with /data: (\{[^\n]*)/
```

## Without a transport

`executeOperation(app, app.operations.name, env, principal, input, authority?)` from
`@arbol-ai/maximus/internals` runs the shared execution path (input decoding, derive, middleware,
handler, output check) for RPC-only operations. Principal:
`{ actorId, actorKind, organizationId: 'org_' + 16 alphanumerics, requestId: crypto.randomUUID() }`.

## Contract smoke

`verifyContract((request) => handle(request, env), origin)` from `@arbol-ai/maximus/testing` checks
that `/openapi.json` and `/openapi.yaml` are the same document and returns `{ paths, operations }`.
Run one per service against the real Worker (workerd or a deployment).

## workerd

Durable Objects, real bindings and Service Bindings: Cloudflare's Vitest integration with remote
bindings off, or Miniflare with several Workers.

## RPC types

```ts
type AssertFalse<T extends false> = T;
type IsNever<T> = [T] extends [never] ? true : false;
export type QuoteReturnExists = AssertFalse<IsNever<Awaited<ReturnType<Service<typeof PricingService>['quoteItems']>>>>;
// @ts-expect-error The control must fail; otherwise the check proves nothing.
export type NeverControl = AssertFalse<IsNever<never>>;
```

## CI rules

Synthetic data only; no live providers, paid services or production resources; remote bindings
off. Scripts call domain functions or the service over HTTP, never a second provider implementation.
Keep security, privacy and retry tests where they are.
