# Middleware and context

This guide covers what a handler receives, how to prepare typed context with `.derive()`, how to
wrap execution with `.use()`, and how to split a service into resource modules with `.mount()`.

## What a handler receives

```ts
async (context, input) => {
  context.env; // Worker bindings
  context.principal; // { actorId, actorKind, organizationId, requestId }
  context.authority; // verified scopes and client, when the call carried a token or a proof
  context.operation; // the operation name
  context.background; // { waitUntil }, best effort
};
```

| Field        | Present                                           | Meaning                                                                                                                                                                                        |
| ------------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env`        | Always                                            | The Worker's bindings. Inside `http.aroundOperation`, the environment that hook passed on.                                                                                                     |
| `principal`  | Always                                            | The verified caller. Use `principal.organizationId` for every tenant query.                                                                                                                    |
| `authority`  | HTTP and MCP calls whose principal has a `client` | `{ surface, scopes, client, token? }`, frozen; `token` is the verified access token, for calling another service as the same caller (never log, store or return it). Absent over ordinary RPC. |
| `input`      | Always                                            | The decoded input, the same value as the handler's second argument.                                                                                                                            |
| `operation`  | Always                                            | The operation's name, from the definition, never from the request.                                                                                                                             |
| `background` | When the runtime provides one                     | `waitUntil(promise)` for bounded work after the response.                                                                                                                                      |
| `body`       | Byte uploads only                                 | `read()` for the request bytes; see [Files](http-and-openapi.md#files).                                                                                                                        |

The default OAuth verification always sets a client, so `authority` is present on HTTP and MCP. A
custom `tokens.resolve` that returns no `client` produces calls without `authority`, which makes
operations with `conditionalScopes` fail closed.

`background.waitUntil` keeps a promise running after the response, within the platform's limits. It
is best effort: use a Queue or a Workflow for work that must happen.

## Prepare context with derive

```ts
const connected = base.derive(async ({ env, principal }) => {
  const account = await loadAccount(env.ACCOUNTS, principal.organizationId);
  return account ? ok({ account }) : err(errors.accountNotConnected.create());
});

export const reports = connected.operation('listReports', definition, async ({ account }, input) => {
  // `account` is typed and ready.
});
```

- `.derive()` must come before any `.operation()` on the same chain; calling it after one throws.
- It runs once per call, after authentication, scope checks and input validation, and before
  middleware. Its fields merge into the context, and a later `.derive()` sees earlier ones.
- Returning a failure ends the call with that failure, validated against the catalog and, when the
  operation declares its `failures`, against them: a domain failure it does not declare becomes
  `INTERNAL_ERROR`, as one its handler returned would. The handler does not run.

Keep preparation in one module per concern. Do not repeat token parsing, session lookup or
`withConnection(context, callback)` wrappers in every handler.

## Scope preparation to the operations that need it

Each operation captures the preparation of its own chain. Operations that set a connection up must
not require one:

```ts
const base = maximus<Env>(configuration);

// Business operations need a connected account.
const connected = base.derive(async ({ env, principal }) => {
  const result = await resolveConnection(env, principal.organizationId);
  return result.ok ? ok({ connection: result.value }) : result;
});
const records = connected.operation('lookupRecord', lookupDefinition, ({ connection }, input) =>
  connection.lookup(input)
);

// Setting the connection up must work before one exists.
const management = base.operation('configureConnection', setupDefinition, configureConnection);

export const app = base.mount(records).mount(management).build();
```

`configureConnection` never runs `resolveConnection`.

## Wrap execution with use

```ts
const guarded = base.use(async ({ env }, proceed) =>
  env.MAINTENANCE === 'true' ? err(errors.upstreamUnavailable.create()) : await proceed()
);
```

Middleware receives the context and `proceed`, and returns a `Result`:

- Call `proceed()` at most once and return its result, possibly after acting on it. A second call
  answers `INTERNAL_ERROR`.
- Or return your own `Result` without calling `proceed()` to short-circuit.
- Whatever middleware returns is validated like a handler result: a value must match the output
  schema, a failure must be in the catalog.
- `.use()` applies to operations declared after it on that chain. Earlier operations keep the
  middleware they captured.
- Several `.use()` calls run in declaration order, around the handler, after every `.derive()` of
  the chain.

Middleware is trusted application code that runs after admission. It is not an authentication
mechanism and cannot bypass one; work that must happen before authorization belongs in an HTTP hook
(see [Worker composition](worker-composition.md#hooks)), and a different authentication model belongs
in a separately reviewed plain route.

## Organize resource modules

```text
src/
  application.ts       the base: maximus<Env>(configuration)
  api/
    tasks/
      schemas.ts       TypeBox schemas for the resource
      tasks.ts         named domain functions
      operations.ts    export const tasks = base.operation(…)…
  app.ts               export const app = base.mount(tasks).build()
  index.ts             createWorker(app, …)
```

- Every module starts from the same base; mounting a builder from another `maximus()` call throws.
- A duplicate operation name throws when mounted, and a duplicate route when built.
- `operations.ts` declares the transport contract; named domain functions do the work; provider
  protocol and parsing live in their own modules. Folder readability matters more than removing a few
  repeated lines.
- `app.ts` only composes, so tests and scripts can import it without starting a Worker.

The [`http-and-mcp`](../../examples/http-and-mcp) example uses this layout.

Keep one repository per independently released service. Use a monorepo (with Turborepo, for example)
when one product has several applications or shared packages, and do not add empty applications in
advance.

## Organization credentials

`@arbol-ai/maximus/workers` exports `credentials` for services that keep one credential per
organization in a Durable Object:

```ts
import { credentials } from '@arbol-ai/maximus/workers';

const connected = base.derive(({ env, principal }) =>
  credentials({ principal, accounts: env.ACCOUNTS, schema: CredentialSchema })
);
```

`accounts` is a namespace whose `getByName(organizationId)` returns an object with
`readCredential(organizationId)`, answering a `Result`. The helper reads once, validates the value
against `schema` and checks that its `organizationId` equals the principal's; anything else is
`INTERNAL_ERROR`. Handlers then receive `credential`, typed. The helper owns no storage; the account
owner implements `readCredential`.

## Validation inside handlers

The input your handler receives is already decoded and checked, and its output will be checked once.
Inside that boundary:

- Pass typed values to named domain functions; do not parse them again.
- When an RPC method of your own wraps an implementation, call the typed implementation internally
  instead of re-entering the validating method.
- Validate what crosses another trust boundary: a provider response, a stored record, a model answer.
  See [Schemas and validation](schemas-and-validation.md#reading-untrusted-data).
