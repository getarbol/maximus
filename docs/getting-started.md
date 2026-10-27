# Getting started

In this guide you build a small notes service, run it locally with `cf dev`, call it over HTTP,
and then expose the same operations to MCP clients. It takes about fifteen
minutes. The finished code is in [`examples/minimal-http`](../examples/minimal-http).

## Prerequisites

- [Bun](https://bun.sh) 1.4, and Node.js 22 or later, on which `cf` runs.
- [`cf`](https://developers.cloudflare.com/cf/), Cloudflare's CLI, which develops, builds and deploys
  the Worker through Cloudflare's Vite plugin. It is in beta. You need a Cloudflare account only to
  deploy.
- TypeScript 5.7 or later: the declarations use the generic typed arrays (`Uint8Array<ArrayBuffer>`)
  that 5.7 introduced. Maximus itself is developed with TypeScript 7.

## Install

```sh
bun add @arbol-ai/maximus
bun add -d cf vite @cloudflare/vite-plugin@beta typescript @cloudflare/workers-types
```

`bun --bun maximus init <directory> --name <name>` creates the same kind of project, with tests, lint
and CI, in one step; this guide builds it by hand.

`@arbol-ai/maximus` is the whole framework, one entry per concern: the root holds definitions,
schemas, tokens, errors, HTTP and OpenAPI; `@arbol-ai/maximus/workers` turns an application into a
Cloudflare Worker. A bundle carries only the entries it imports.

A `tsconfig.json` that works for a Worker:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowImportingTsExtensions": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node", "@cloudflare/workers-types"]
  },
  "include": ["src/**/*.ts", "*.config.ts"]
}
```

## Configure the Worker

`cloudflare.config.ts` describes the Worker to `cf`:

```ts
import { bindings, defineConfig } from 'cf/config';

import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

export default defineConfig(({ mode }) => ({
  worker: {
    name: 'example-notes',
    compatibilityDate: '2026-10-12',
    // Maximus keeps per-invocation diagnostics in AsyncLocalStorage (node:async_hooks).
    compatibilityFlags: ['nodejs_compat'],
    entrypoint,
    observability: { enabled: true },
    env: {
      // `cf dev` keeps the notes locally; `cf deploy` creates the namespace, since this names no id.
      NOTES: bindings.kv(),
      // The development token in .dev.vars, declared for `cf dev` alone: no deployed build carries it.
      DEVELOPMENT_TOKEN: mode === 'development' && bindings.secret(),
    },
  },
}));
```

`vite.config.ts` adds Cloudflare's Vite plugin, which `cf` builds and runs the Worker with:

```ts
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig({ plugins: [cloudflare()] });
```

`nodejs_compat` is required: Maximus keeps per-request diagnostics in `node:async_hooks`.

## Decide how callers authenticate

Every Maximus operation requires a bearer token whose principal names an organization. By default
Maximus verifies OAuth access tokens: signature (RS256, from the issuer's JWKS), issuer, audience and
expiry. In production you point `tokens.issuer` and `tokens.audience` at your authorization server.

To run locally without one, also accept a development token, only from `localhost`. `src/tokens.ts`:

```ts
import type { TokenPolicy } from '@arbol-ai/maximus';

/** Replace the issuer and the audience with your authorization server and your API. */
export const tokens: TokenPolicy = {
  issuer: 'https://auth.example.com/',
  audience: 'https://notes.example.com',
  development: { binding: 'DEVELOPMENT_TOKEN' },
};
```

Put a long random `DEVELOPMENT_TOKEN` in `.dev.vars`, which only `cf dev` reads, for the binding that
`cloudflare.config.ts` declares in development mode alone. From `localhost`, that token, at least 32
characters, is a developer holding every scope your operations declare; every other token must be a
valid OAuth access token. Never set it on a deployed Worker.
Auth0's access tokens work as they are; Okta, WorkOS and other providers that name their claims
differently need one more setting, which [Authentication and scopes](guides/authentication-and-scopes.md)
explains with the other options.

## Define the service

`src/app.ts` declares the application and three operations:

```ts
import { defineErrors, err, maximus, ok, t, UuidSchema } from '@arbol-ai/maximus';
import { readSchema } from '@arbol-ai/maximus/schemas';

import { tokens } from './tokens';

/** The part of a Workers KV namespace this service uses. */
export interface NoteStore {
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string) => Promise<void>;
  list: (options: { prefix: string; limit: number }) => Promise<{ keys: { name: string }[] }>;
}

/** The bindings declared in cloudflare.config.ts, plus the local-only development token. */
export interface Env {
  NOTES: NoteStore;
  DEVELOPMENT_TOKEN?: string;
}

const NoteSchema = t.Object(
  {
    noteId: UuidSchema,
    text: t.String({ minLength: 1, maxLength: 2000 }),
    createdAt: t.String({ format: 'date-time' }),
  },
  { additionalProperties: false }
);

const errors = defineErrors({
  noteNotFound: { code: 'NOTE_NOT_FOUND', status: 404, message: 'The note does not exist.' },
});

/** Every key starts with the verified organization, so one tenant never reads another's notes. */
function noteKey(organizationId: string, noteId: string): string {
  return `notes/${organizationId}/${noteId}`;
}

/** Stored values are untrusted until read through their schema. */
async function readNote(store: NoteStore, key: string) {
  const stored = await store.get(key);
  return stored === null ? null : readSchema(NoteSchema, JSON.parse(stored));
}

export const app = maximus<Env>({
  name: 'example-notes',
  namespace: 'notes',
  title: 'Notes',
  version: '1.0.0',
  origin: 'https://notes.example.com',
  tokens,
  errors,
  rpc: { callers: [] },
})
  .operation(
    'createNote',
    {
      scope: 'notes:notes:write',
      effect: 'write',
      title: 'Create a note',
      description: "Store a note for the caller's organization.",
      input: t.Object({ text: NoteSchema.properties.text }, { additionalProperties: false }),
      output: NoteSchema,
      http: { method: 'POST', path: '/v1/notes', successStatus: 201 },
    },
    async ({ env, principal }, input) => {
      const note = { noteId: crypto.randomUUID(), text: input.text, createdAt: new Date().toISOString() };
      await env.NOTES.put(noteKey(principal.organizationId, note.noteId), JSON.stringify(note));
      return ok(note);
    }
  )
  .operation(
    'getNote',
    {
      scope: ['notes:notes:read', 'notes:notes:write'],
      effect: 'read',
      title: 'Get a note',
      description: 'Read one note by its identifier.',
      input: t.Object({ noteId: UuidSchema }, { additionalProperties: false }),
      output: NoteSchema,
      http: { method: 'GET', path: '/v1/notes/{noteId}' },
    },
    async ({ env, principal }, input) => {
      const note = await readNote(env.NOTES, noteKey(principal.organizationId, input.noteId));
      return note ? ok(note) : err(errors.noteNotFound.create());
    }
  )
  .operation(
    'listNotes',
    {
      scope: ['notes:notes:read', 'notes:notes:write'],
      effect: 'read',
      title: 'List notes',
      description: "List up to 50 of the organization's notes.",
      input: t.Object({}, { additionalProperties: false }),
      output: t.Object({ notes: t.Array(NoteSchema) }, { additionalProperties: false }),
      http: { method: 'GET', path: '/v1/notes' },
    },
    async ({ env, principal }) => {
      const { keys } = await env.NOTES.list({ prefix: noteKey(principal.organizationId, ''), limit: 50 });
      const notes = await Promise.all(keys.map(({ name }) => readNote(env.NOTES, name)));
      return ok({ notes: notes.filter((note) => note !== null) });
    }
  )
  .build();
```

What each part does:

- **`name`, `title`, `version`** identify the service in health checks, OpenAPI and MCP.
- **`namespace`** prefixes every scope: `notes:notes:write` is `<namespace>:<resource>:<action>`.
- **`origin`** is the public HTTPS URL. OpenAPI and OAuth discovery advertise it, even while you run
  on `localhost`.
- **`errors`** is the error catalog: the standard failures plus `NOTE_NOT_FOUND` with status 404.
- **`rpc.callers`** lists the Workers allowed to call over native RPC; none here.
- **Each operation** declares its scope, effect, strict schemas and its HTTP route. `getNote` takes
  its `noteId` from the path; `scope` as a list means either scope admits the caller.
- **Each handler** reads the organization from the verified principal and returns `ok(...)` or a
  catalog failure with `err(...)`.

The `NoteStore` interface names only what the service uses. A real KV namespace satisfies it, and a
test can pass a `Map`.

`src/index.ts` turns the application into a Worker:

```ts
import { createWorker } from '@arbol-ai/maximus/workers';

import { app } from './app';

const worker = createWorker(app);

export default worker.handler;
```

## Run it

Create a development token for `cf dev`. `.dev.vars` is read only locally; keep it out of version
control.

```sh
echo "DEVELOPMENT_TOKEN=$(openssl rand -hex 32)" > .dev.vars
bunx cf dev
```

`cf dev` serves the Worker at `http://localhost:5173`, Vite's port.

## Call it over HTTP

```sh
TOKEN=$(sed 's/^DEVELOPMENT_TOKEN=//' .dev.vars)

curl -s -X POST http://localhost:5173/v1/notes \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"text":"Buy coffee"}'
```

```json
{
  "success": true,
  "data": {
    "noteId": "52c1c205-ab35-452c-8168-48e321725db1",
    "text": "Buy coffee",
    "createdAt": "2026-10-11T09:47:15.785Z"
  },
  "error": null,
  "metadata": { "requestId": "3c393e81-69f4-4c86-9f1e-5f8f0e8f2d41" }
}
```

Every response carries an `x-request-id` header with the same id. Try the failure paths:

```sh
curl -s http://localhost:5173/v1/notes                    # 401 UNAUTHORIZED, with a WWW-Authenticate challenge
curl -s -X POST http://localhost:5173/v1/notes \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":""}'                                          # 400 INVALID_INPUT
```

An invalid input names the refused fields, never their values:

```json
{
  "success": false,
  "data": null,
  "error": {
    "code": "INVALID_INPUT",
    "message": "The request does not match the published schema.",
    "retryable": false,
    "data": { "issues": [{ "path": "/text", "message": "Expected string length greater or equal to 1" }] }
  },
  "metadata": { "requestId": "2317081e-acdf-4e1b-a725-b282e99c9e6c" }
}
```

## Read the contract

The service documents itself at runtime:

```sh
curl -s http://localhost:5173/openapi.json   # also /openapi.yaml and /openapi.yml
curl -s http://localhost:5173/health          # {"status":"ok","service":"example-notes","version":"1.0.0"}
```

The OpenAPI 3.1 document is generated from the same definitions that run the service: routes,
schemas, scopes as OAuth security requirements, effects and every failure the catalog can return.

## Expose the same operations over MCP

Configure MCP on the application and name a tool on each operation it should offer:

```ts
export const app = maximus<Env>({
  // ...the same configuration
  mcp: { instructions: "Notes of the caller's organization. Read a note before quoting it." },
}).operation(
  'createNote',
  {
    // ...the same definition
    mcp: { name: 'create_note', idempotent: false },
  },
  handler
);
```

Mount the transport in `src/index.ts`:

```ts
import { mcp } from '@arbol-ai/maximus/mcp';
import { createWorker } from '@arbol-ai/maximus/workers';

import { app } from './app';

const worker = createWorker(app, { transports: [mcp()] });

export default worker.handler;
```

The MCP endpoint is `/mcp` (Streamable HTTP). A token needs `notes:mcp:use` to open it, and sees only
the tools whose scopes it carries; the development token holds every declared scope. List the tools:

```sh
curl -s http://localhost:5173/mcp \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Any MCP client that supports Streamable HTTP and a custom `Authorization` header can connect to
`http://localhost:5173/mcp`. The [`http-and-mcp`](../examples/http-and-mcp) example shows a complete
MCP service with guides and skills.

## Next steps

- [Concepts](concepts.md): the model and the vocabulary.
- [HTTP and OpenAPI](guides/http-and-openapi.md): routes, query strings, files and the contract.
- [Errors and results](guides/errors-and-results.md): designing failures.
- [Testing](guides/testing.md): the test in `examples/minimal-http/tests` runs the service without
  Workers.
- [Deploying](guides/deploying.md): `cf build`, `cf deploy` and verifying a deployment.
