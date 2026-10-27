# Context and middleware

This guide covers what a handler receives besides its input, how `context.ts` prepares it for every call,
and the code that runs around requests and around operations: request middleware and operation
middleware. Its last sections show the builder's `.derive()`, `.use()` and `.mount()`, which do the same
in a Worker composed by hand.

## What a handler receives

A route's or a tool's handler receives one object:

```ts
export default defineHandler(async ({ input, principal, authority, env, operation, fail, notes }) => {
  // …
});
```

| Field                     | Present                                          | Meaning                                                                                                                                        |
| ------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `input`                   | Always                                           | The input, decoded and checked against the contract once.                                                                                      |
| `principal`               | Always                                           | The verified caller: `actorId`, `actorKind`, `organizationId` and `requestId`. Scope every store, query and key by `principal.organizationId`. |
| `authority`               | On HTTP and MCP calls whose token names a client | What admission verified about the token, frozen: `surface`, `scopes`, `client` and `token`. See below.                                         |
| `env`                     | Always                                           | The Worker's bindings, typed by the generated `Env`.                                                                                           |
| `operation`               | Always                                           | The operation's name, such as `getNote`; never taken from the request.                                                                         |
| `background`              | When the runtime provides one                    | `waitUntil(promise)`, for work that may outlive the answer.                                                                                    |
| `fail`                    | Always                                           | Answers a failure of the catalog: `return fail('NOTE_NOT_FOUND')`.                                                                             |
| `body`                    | On routes that declare `http: { body: 'bytes' }` | `read()`, which reads the request's bytes once, within the route's limit. See [Routes](routes.md).                                             |
| What `context.ts` returns | Always                                           | Such as `notes`, below.                                                                                                                        |

`authority.surface` is `http` or `mcp`, `authority.scopes` the scopes the token grants, which a handler
checks its [conditional scopes](authentication-and-scopes.md#scopes-the-handler-checks) against, and
`authority.client` the OAuth client, with its `id` and its class (`human`, `machine` or `dcr`).
`authority.token` is the verified bearer token, for an operation that calls another service as the same
caller, which verifies it again; it is absent under the application's own `bearer` scheme. Never log,
store or return it. Calls over [Worker RPC](worker-rpc.md) and calls whose token names no client carry no
`authority`.

`background.waitUntil` keeps a promise running after the answer, within the platform's limits. It is best
effort: work that must happen belongs in a queue or a workflow (see [Background work](background-work.md)).

## Prepare the context

`context.ts`, at the project's root, prepares what every handler receives besides the invocation. Its
default export is `defineContext(prepare)`:

```ts
// context.ts
import { defineContext } from '@arbol-ai/maximus';

import { noteStore } from './src/notes.ts';

/** What every handler receives besides its input: the caller's organization's notes. */
export default defineContext(({ env, principal }) => ({
  notes: noteStore(env.NOTES, principal.organizationId),
}));
```

`prepare` runs once per call, on HTTP, MCP and RPC alike, after the caller is admitted and the input
decoded, and before operation middleware and the handler. It receives the invocation (`env`,
`principal`, `authority`, `input`, `operation` and `background`) and `fail`, and returns an object, or a
promise of one. Its values join the arguments of every route's and tool's handler, and of operation
middleware, with their types: `maximus prepare` registers them in `.maximus/register.d.ts`. A call refused
before it runs, for its token, its scope, its rate limit, its body or its input, never prepares a context,
so it never reaches the stores the context opens.

### Answer a call from the context

`fail(code)` answers the call with a failure of the catalog instead of preparing the context. Say each
organization enables notes in a settings namespace:

```ts
// context.ts
import { defineContext } from '@arbol-ai/maximus';

import { noteStore } from './src/notes.ts';

/** The caller's organization's notes, once the organization has enabled them. */
export default defineContext(async ({ env, principal, fail }) => {
  const enabled = await env.ORGANIZATIONS.get(`${principal.organizationId}/notes-enabled`);
  if (enabled !== 'true') {
    return fail('NOTES_NOT_ENABLED');
  }
  return { notes: noteStore(env.NOTES, principal.organizationId) };
});
```

with the failure in `errors.ts`:

```ts
// errors.ts
import { defineErrors } from '@arbol-ai/maximus';

export default defineErrors({
  noteNotFound: { code: 'NOTE_NOT_FOUND', status: 404, message: 'The note does not exist.' },
  notesNotEnabled: {
    code: 'NOTES_NOT_ENABLED',
    status: 409,
    message: 'Notes are not enabled for the organization.',
  },
});
```

The handler does not run, and the call answers `409` with `NOTES_NOT_ENABLED`. The failure is held to the
route as a handler's would be: a route that lists its `failures` answers a domain code of the context only
when it lists that code too. Otherwise the call answers `INTERNAL_ERROR`, and the undeclared failure is
reported. [Errors and results](errors-and-results.md) covers declared failures.

`context.ts` loads in Node as well as in the Worker, since tests import the application, so it imports
nothing that loads in workerd alone: a runtime import of a `cloudflare:` module,
`@arbol-ai/maximus/workers` or `@arbol-ai/maximus/project` is refused with
`Configuration must remain importable outside workerd: <module> in <file>. Import its types only.` Its
default export must come from `defineContext`. [Project structure](project-structure.md) lists the rules
of every file.

## Request middleware

A file of `middleware/` whose default export is `defineMiddleware(handle)`, from
`@arbol-ai/maximus/config`, wraps every request the Worker answers. The starter's adds a response header:

```ts
// middleware/10-response.ts
import { defineMiddleware } from '@arbol-ai/maximus/config';

export default defineMiddleware<Env>(async (_request, _env, _context, proceed) => {
  const response = await proceed();
  // Rebuilding a WebSocket upgrade would lose its socket.
  if (response.status === 101) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set('referrer-policy', 'no-referrer');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
});
```

Request middleware runs in the order of the files' names, each around the next, so numeric prefixes fix
the order. It wraps everything: the API, the MCP server, discovery, the health check, pages and a web
app's files. It runs before the route is matched and before the token is read, so it never sees a
principal and cannot admit a caller: it can only add to a request's answer, or answer the request itself.

`handle` receives:

- `request`, a copy of the request without its body. Changing its headers changes nothing admission reads.
- `env`, the Worker's bindings.
- `context`, with the request's `requestId`, `fail(failure, headers?)`, which answers a failure of the
  catalog in the standard envelope, and `waitUntil(promise)`.
- `proceed()`, which runs the rest of the request and resolves to its answer.

Return `proceed()`'s answer, a new one built from it, or your own without calling `proceed()`: then the
route does not run and its token is never read. `proceed()` runs at most once, and only until the
middleware's own promise settles: a second call answers the request with `INTERNAL_ERROR`, and a call
after it settles throws. An error the middleware throws answers `INTERNAL_ERROR` too, and is reported by
its safe description.

A WebSocket upgrade answers with status `101` and carries its socket outside the `Response` constructor's
options: a middleware that rebuilds the answer returns a `101` as it is, as the starter does. Maximus
leaves it untouched too. Every other answer, after the last middleware, gets its `x-request-id`,
`x-content-type-options: nosniff` and `server-timing` headers, and `cache-control: private, no-store`
unless a page or a web app's file sets its own.

Policy that depends on who calls belongs in operation middleware, which runs after admission and on
every transport. Request middleware never runs for a call over Worker RPC, which is no HTTP request.

## Operation middleware

A file of `middleware/` whose default export is `defineOperationMiddleware(handle)` runs around the
handler of every route and tool, on HTTP, MCP and RPC, after the caller is admitted and `context.ts` has
prepared the context:

```ts
// middleware/20-frozen.ts
import { err, standardErrors } from '@arbol-ai/maximus';
import type { PreparedContext } from '@arbol-ai/maximus';
import { defineOperationMiddleware } from '@arbol-ai/maximus/config';

import type context from '../context.ts';

/** An organization an operator has frozen answers FORBIDDEN on every route and tool. */
export default defineOperationMiddleware<PreparedContext<typeof context>>(
  async ({ env, principal }, proceed) =>
    (await env.ORGANIZATIONS.get(`${principal.organizationId}/frozen`)) === 'true'
      ? err(standardErrors.forbidden.create())
      : proceed()
);
```

`PreparedContext<typeof context>` types the middleware's argument as the invocation plus what
`context.ts` returns, here `notes` too; import `context.ts` as a type alone. A project without
`context.ts` types it `Invocation<Env>`.

`handle` receives that context and `proceed()`, and answers a `Result` (see
[Errors and results](errors-and-results.md)): the one `proceed()` resolves to, after acting on it if it
needs to, or its own, without calling `proceed()`, which answers the call before the handler runs.
Whatever it answers is checked as a handler's answer is: a value against the output schema, a failure
against the catalog and the route's declared failures. `proceed()` runs at most once; a second call
answers `INTERNAL_ERROR`.

Operation middleware runs in the order of the files' names too. Request and operation middleware share
`middleware/`, and each phase keeps its own order: no file name moves operation middleware before
admission.

## The order of a call

An HTTP call to a route goes through these steps, in this order, and stops at the first refusal:

1. Request middleware, in the order of its files, around everything below.
2. The route is matched by its method and path. A path no route answers is `404`; discovery, the health
   check and pages answer here, without a token.
3. Token admission: the token, then the route's scope (`401` or `403`).
4. The rate limit, when the service sets one (`429`).
5. The body is refused unread when it is not `application/json` and the route does not read bytes
   (`415`), and otherwise read within the route's limit (`413`). The input is taken from the path, the
   query and the body (`400`).
6. The caller's eligibility: its actor kind, and an `authority` for a route with conditional scopes (`403`).
7. The input is decoded and checked against the contract (`400 INVALID_INPUT`).
8. `context.ts` prepares the context, or answers its failure.
9. Operation middleware, in the order of its files, around the handler.
10. The handler answers its output or `fail(code)`.
11. The answer is checked: the output against its schema and limit, a failure against the catalog and the
    route's declared failures. Anything else answers `INTERNAL_ERROR`.
12. Request middleware receives the answer on its way out, and Maximus sets its headers.

An MCP request goes through steps 1 to 5 as a whole, with the scope `<namespace>:mcp:use` and a body
limit sized by the tools the caller may call; each tool call in it then checks the tool's own scope and
runs steps 6 to 11. A call over Worker RPC has no request middleware, token or rate limit: the callee
checks the calling Worker and the principal it forwards, then runs steps 6 to 11. Whatever the
transport, the input and the answer are each checked once. See
[One execution path](../concepts.md#one-execution-path).

## In a Worker composed by hand

A Worker composed by hand from the application builder (see
[Worker composition](worker-composition.md)) prepares and wraps operations in code: `.derive()` is
`context.ts`, `.use()` is operation middleware, and request middleware is the `http.middleware` option of
`createWorker` and `createHttpHandler`, a list of the same functions `defineMiddleware` takes.

### Prepare with derive

```ts
import { defineErrors, err, maximus, ok, t, UuidSchema } from '@arbol-ai/maximus';

import { NoteSchema, noteStore } from './notes.ts';

/** The bindings this Worker declares. */
interface Env {
  NOTES: KVNamespace;
  ORGANIZATIONS: KVNamespace;
}

const errors = defineErrors({
  noteNotFound: { code: 'NOTE_NOT_FOUND', status: 404, message: 'The note does not exist.' },
  notesNotEnabled: {
    code: 'NOTES_NOT_ENABLED',
    status: 409,
    message: 'Notes are not enabled for the organization.',
  },
});

const base = maximus<Env>({
  name: 'notes',
  namespace: 'notes',
  title: 'Notes',
  version: '1.0.0',
  origin: 'https://notes.example.com',
  tokens: { issuer: 'https://auth.example.com/', audience: 'https://notes.example.com' },
  errors,
  rpc: { callers: [] },
});

/** The caller's organization's notes, once the organization has enabled them. */
const withNotes = base.derive(async ({ env, principal }) =>
  (await env.ORGANIZATIONS.get(`${principal.organizationId}/notes-enabled`)) === 'true'
    ? ok({ notes: noteStore(env.NOTES, principal.organizationId) })
    : err(errors.notesNotEnabled.create())
);

const noteOperations = withNotes.operation(
  'getNote',
  {
    scope: 'notes:notes:read',
    effect: 'read',
    title: 'Get a note',
    description: 'Read one note of the organization by its id.',
    input: t.Object({ noteId: UuidSchema }, { additionalProperties: false }),
    output: NoteSchema,
    failures: ['NOTE_NOT_FOUND', 'NOTES_NOT_ENABLED'],
    http: { method: 'GET', path: '/v1/notes/{noteId}' },
  },
  async ({ notes }, input) => {
    const note = await notes.get(input.noteId);
    return note ? ok(note) : err(errors.noteNotFound.create());
  }
);

export const app = base.mount(noteOperations).build();
```

`.derive(resolve)` adds what `resolve` answers, `ok({ … })`, to the context of every operation declared
after it on that chain, with its type; `err(failure)` answers the call instead, held to the operation's
declared failures as a handler's failure is. It runs as `context.ts` does: once per call, after admission
and input decoding, before the middleware. A later `.derive()` receives what earlier ones added. Derive
before declaring operations: on a builder that already has one, `.derive()` throws
`Derive context before declaring operations.`

A builder is immutable, and each operation keeps the preparation of the chain it was declared on. That
lets a Worker composed by hand prepare only the operations that need it, which a project's `context.ts`,
shared by every route, cannot. The operation that enables notes must run before they are enabled, so it
is declared on the base, without `withNotes`, and the application mounts both:

```ts
const settings = base.operation(
  'enableNotes',
  {
    scope: 'notes:settings:write',
    effect: 'write',
    title: 'Enable notes',
    description: 'Enable notes for the organization.',
    input: t.Object({}, { additionalProperties: false }),
    output: t.Object({}, { additionalProperties: false }),
    http: { method: 'POST', path: '/v1/settings/enable-notes' },
  },
  async ({ env, principal }) => {
    await env.ORGANIZATIONS.put(`${principal.organizationId}/notes-enabled`, 'true');
    return ok({});
  }
);

export const app = base.mount(noteOperations).mount(settings).build();
```

### Wrap with use

`.use(middleware)` wraps every operation declared after it on that chain, as a file of operation
middleware does, and with the same rules: `middleware` receives the context and `proceed`, answers a
`Result`, and calls `proceed()` at most once.

```ts
import { err, standardErrors } from '@arbol-ai/maximus';

/** A frozen organization answers FORBIDDEN on every operation declared after this. */
const guarded = withNotes.use(async ({ env, principal }, proceed) =>
  (await env.ORGANIZATIONS.get(`${principal.organizationId}/frozen`)) === 'true'
    ? err(standardErrors.forbidden.create())
    : proceed()
);
```

Several `.use()` calls run in the order they were declared, around the handler and after every
`.derive()` of the chain. An operation declared before a `.use()` keeps the middleware it was declared
with.

### Compose modules with mount

`.mount(module)` adds the operations of a builder that descends from the same `maximus()` call, each with
the context and middleware it was declared with. Keep each resource in its own module, with its schemas,
its named domain functions and its operations, and let one module compose them. A module of another
application throws `Resource groups must derive from the same application.`, and an operation name
declared twice throws `Duplicate operation: <name>`, with the route or tool of each when both have one.

### Organization credentials

`credentials` from `@arbol-ai/maximus/workers` prepares one credential per organization, kept in the
organization's own store, such as a Durable Object per organization in the namespace `ACCOUNTS`:

```ts
import { credentials } from '@arbol-ai/maximus/workers';

const connected = base.derive(({ env, principal }) =>
  credentials({ principal, accounts: env.ACCOUNTS, schema: CredentialSchema })
);
```

`accounts.getByName(organizationId)` addresses the organization's store, and its
`readCredential(organizationId)` answers a `Result`. A failure it answers is the call's; a credential
that does not match `schema`, or whose `organizationId` is not the caller's, answers `INTERNAL_ERROR`.
Handlers then receive `credential`, typed by `schema`. The helper owns no storage: the store implements
`readCredential`.

## Validation inside handlers

The input a handler receives is decoded and checked once, and its answer is checked once on the way out.
Inside that boundary:

- Pass typed values to named domain functions; do not parse them again.
- When an RPC method of your own wraps an implementation, call the typed implementation internally rather
  than the validating method.
- Check what crosses another boundary: a provider's response, a stored record, a model's answer. See
  [Schemas and validation](schemas-and-validation.md).
