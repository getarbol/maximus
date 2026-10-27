# Getting started

In this tutorial you build a notes service on Cloudflare Workers. It keeps each organization's notes in
Workers KV, answers over HTTP, and serves one of its routes to AI agents as an MCP tool. You run it locally,
test it in Node and deploy it. It takes about fifteen minutes.

You need [Bun](https://bun.sh) 1.4, which runs every command, and Node.js 22.18 or later installed beside
it: Cloudflare's local runtime, which `vp dev` starts, runs on Node.js. A Cloudflare account is needed only
for the last step.

## Create the project

```sh
bun create maximus notes
```

`create-maximus` asks two questions: whether the project serves its routes to agents over MCP (answer yes)
and whether it includes a React web app (answer no). `--yes` takes those answers without asking. It writes:

```text
notes/
├── vite.config.ts               The only configuration: the application and the Worker that serves it
├── routes/v1/greeting.get.ts    GET /api/v1/greeting, also the MCP tool get_greeting
├── routes/v1/greeting.post.ts   POST /api/v1/greeting
├── mcp/instructions.md          What MCP clients read when they connect
├── middleware/10-response.ts    A response header on every request
├── pages/index.ts               GET /, a public page outside the API
├── tests/                       The API and its MCP server, tested in Node
├── .dev.vars                    A development token for vp dev, never committed
├── .github/workflows/ci.yml     Verifies pull requests and deploys main
└── CLAUDE.md, AGENTS.md         The project's guide for coding agents, with the Maximus skill
```

Install the dependencies and start the development server:

```sh
cd notes
bun install
bun run dev
```

`bun run dev` runs `vp dev`, which serves the Worker in workerd, Cloudflare's runtime, at
`http://localhost:5173`. On every start, and on every build, Maximus writes `.maximus/` from `vite.config.ts`
and the project's files: the Worker's entry, the table of routes and the `Env` type of its bindings. It is
generated; never edit it.

## Call the API

The API lives under `/api`, and every route in it requires an access token. Locally, the development token in
`.dev.vars` stands in for one:

```sh
TOKEN=$(cut -d= -f2 .dev.vars)
curl -H "authorization: Bearer $TOKEN" http://localhost:5173/api/v1/greeting
```

```json
{ "success": true, "data": { "message": "Hello World" }, "error": null, "metadata": { "requestId": "…" } }
```

`vp dev` accepts the development token from localhost alone. It signs you in as a developer of the
organization `local-development` who holds every scope the service defines. The binding that carries the
token exists under `vp dev` alone: no build contains it, and a deployed Worker accepts only access tokens from
your authorization server.

Every answer has the same envelope: `data` when `success` is true, `error` when it is false, and
`metadata.requestId`, which the Worker's logs carry too. `/api/openapi.json` describes the API, and `/health`
answers without a token.

## Store notes in Workers KV

Declare the KV namespace as a binding of the Worker, in `maximus()` in `vite.config.ts`:

```ts
import { maximus } from '@arbol-ai/maximus/vite';
import { bindings } from 'cf/config';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [
    maximus({
      origin: 'https://notes.example.com',
      tokens: { issuer: 'https://auth.example.com/' },
      env: { NOTES: bindings.kv() },
      compatibilityDate: '2026-10-27',
    }),
  ],
});
```

The development server restarts when its configuration changes, and the generated `Env` now declares
`NOTES: KVNamespace`. Under `vp dev` the namespace lives on your disk, in `.cloudflare/`; the first deployment
creates it in your Cloudflare account.

Next, the notes themselves. Create `src/notes.ts`:

```ts
import { t, UuidSchema } from '@arbol-ai/maximus';
import type { Static } from '@arbol-ai/maximus';
import { readSchema } from '@arbol-ai/maximus/schemas';

/** A note, as it is stored and answered. */
export const NoteSchema = t.Object(
  {
    noteId: UuidSchema,
    text: t.String({ minLength: 1, maxLength: 2000 }),
    createdAt: t.String({ format: 'date-time' }),
  },
  { $id: 'Note', additionalProperties: false }
);
export type Note = Static<typeof NoteSchema>;

/** The notes of one organization in Workers KV: every key starts with the organization's id. */
export function noteStore(kv: KVNamespace, organizationId: string) {
  const key = (noteId: string) => `notes/${organizationId}/${noteId}`;
  return {
    /** The note, or undefined when the organization has none with this id. */
    async get(noteId: string): Promise<Note | undefined> {
      const stored = await kv.get(key(noteId));
      return stored === null ? undefined : readSchema(NoteSchema, JSON.parse(stored));
    },
    /** Stores a new note and answers it. */
    async create(text: string): Promise<Note> {
      const note: Note = { noteId: crypto.randomUUID(), text, createdAt: new Date().toISOString() };
      await kv.put(key(note.noteId), JSON.stringify(note));
      return note;
    },
  };
}
```

`NoteSchema` is a [TypeBox](https://github.com/sinclairzx81/typebox) schema. It checks notes at runtime, gives
them their TypeScript type through `Static`, and describes them, under its `$id`, in the OpenAPI document and
in the MCP tool's output schema. `readSchema` checks a value read back from storage the same way and throws
when it does not match, so a stored value that is not a note never reaches a caller as one.

A store holds the notes of one organization, and each of its keys begins with that organization's id.

## Give every handler the caller's notes

Create `context.ts` at the project's root:

```ts
import { defineContext } from '@arbol-ai/maximus';

import { noteStore } from './src/notes.ts';

/** What every handler receives besides its input: the caller's organization's notes. */
export default defineContext(({ env, principal }) => ({
  notes: noteStore(env.NOTES, principal.organizationId),
}));
```

The context is built for each call, after the access token is verified, and what it returns joins every
handler's arguments with its type. `principal` is the verified caller: its `organizationId` comes from the
token, never from the request, so a handler reaches only the notes of the caller's own organization.

## Name the failures

Create `errors.ts` at the project's root:

```ts
import { defineErrors } from '@arbol-ai/maximus';

/** The service's own failures: `fail` and `failures` accept their codes. */
export default defineErrors({
  noteNotFound: { code: 'NOTE_NOT_FOUND', status: 404, message: 'The note does not exist.' },
});
```

The catalog gives each code its HTTP status and its message, and both appear in the OpenAPI document. A route
that lists its `failures` can answer only those codes and the
[standard failures](reference/standard-failures.md); any other code is a type error.

## Add the routes

Generate the two route files:

```sh
bunx maximus gen route post /v1/notes
bunx maximus gen route get '/v1/notes/{noteId}' --tool get_note
```

```text
Wrote routes/v1/notes.post.ts: POST /v1/notes.
Wrote routes/v1/notes/[noteId].get.ts: GET /v1/notes/{noteId}, also the MCP tool get_note.
```

Each file holds a placeholder handler and a contract to fill in. Replace `routes/v1/notes.post.ts` with:

```ts
import { defineHandler, t } from '@arbol-ai/maximus';

import { NoteSchema } from '../../src/notes.ts';

/** POST /api/v1/notes: a new note, answered with 201 Created. */
export default defineHandler(({ input, notes }) => notes.create(input.text), {
  description: 'Write a note for the organization.',
  input: { text: t.String({ minLength: 1, maxLength: 2000 }) },
  output: NoteSchema,
  http: { successStatus: 201 },
});
```

and `routes/v1/notes/[noteId].get.ts` with:

```ts
import { defineHandler, UuidSchema } from '@arbol-ai/maximus';

import { NoteSchema } from '../../../src/notes.ts';

/** GET /api/v1/notes/{noteId}, and the MCP tool get_note. */
export default defineHandler(
  async ({ input, notes, fail }) => (await notes.get(input.noteId)) ?? fail('NOTE_NOT_FOUND'),
  {
    description: 'Read one note of the organization by its id.',
    input: { noteId: UuidSchema },
    output: NoteSchema,
    failures: ['NOTE_NOT_FOUND'],
    mcp: { name: 'get_note' },
  }
);
```

A file's name is its route: the path below `routes/`, with `[noteId]` as a parameter, and the method before
`.ts`. From the method and the path, Maximus derives the rest:

| File                              | Serves                       | Operation          | Scope               |
| --------------------------------- | ---------------------------- | ------------------ | ------------------- |
| `routes/v1/notes.post.ts`         | `POST /api/v1/notes`         | `postV1Notes`      | `notes:notes:write` |
| `routes/v1/notes/[noteId].get.ts` | `GET /api/v1/notes/{noteId}` | `getV1NotesNoteId` | `notes:notes:read`  |

A `GET` reads and a `POST` writes, and the scope names the service, the resource and that effect. A token
calls a route only when it holds the route's scope.

The handler receives one object: `input`, decoded and checked against the contract's `input`; the context's
`notes`; the verified `principal`; and `fail`, which answers a failure of the catalog. `noteId` arrives in the
path and `text` in the JSON body. Whatever the handler answers is checked against `output` before it leaves.

A route is an MCP tool only when its contract names one: `get_note` is, and `POST /v1/notes` is not.

## Call the routes

Write a note:

```sh
curl -X POST http://localhost:5173/api/v1/notes \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"text":"Call back on Monday."}'
```

```json
{
  "success": true,
  "data": {
    "noteId": "e1def5d9-f409-4102-b329-0637c91051a2",
    "text": "Call back on Monday.",
    "createdAt": "2026-10-27T07:11:08.277Z"
  },
  "error": null,
  "metadata": { "requestId": "…" }
}
```

The answer's status is `201 Created`. Read the note back with its id:

```sh
curl -H "authorization: Bearer $TOKEN" http://localhost:5173/api/v1/notes/e1def5d9-f409-4102-b329-0637c91051a2
```

Every refusal is a failure in the same envelope, with its own status:

| Request                                | Status | `error.code`     |
| -------------------------------------- | ------ | ---------------- |
| An id the organization has no note for | 404    | `NOTE_NOT_FOUND` |
| `{"text":""}`                          | 400    | `INVALID_INPUT`  |
| No `authorization` header              | 401    | `UNAUTHORIZED`   |

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
  "metadata": { "requestId": "…" }
}
```

The `401` carries a `www-authenticate` header that names the service's OAuth protected resource metadata,
`/api/.well-known/oauth-protected-resource`. An OAuth client reads the authorization server from it.

## Call it from an agent

The MCP server is the Worker's `/mcp` endpoint. An MCP client connects to it with the URL and an access token:
locally, `http://localhost:5173/mcp` and the development token. Every MCP call needs the scope
`notes:mcp:use` besides the tool's own, and the development token holds both.

`tools/list` answers `get_greeting` and `get_note`, with input and output schemas taken from their contracts.
`tools/call` runs the route's handler, with the same checks and the same scope:

```sh
curl -X POST http://localhost:5173/mcp \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_note","arguments":{"noteId":"e1def5d9-f409-4102-b329-0637c91051a2"}}}'
```

```text
event: message
data: {"result":{"content":[{"type":"text","text":"{\"noteId\":…}"}],"structuredContent":{"noteId":"e1def5d9-…","text":"Call back on Monday.","createdAt":"…"}},"jsonrpc":"2.0","id":1}
```

The client also reads `mcp/instructions.md` when it connects. Describe the service there:

```md
notes keeps short notes for the organization your token belongs to. Call get_note with a note's id to read
it. Every call acts for that organization alone.
```

## Test it

Create `tests/notes.test.ts`:

```ts
import { expect, it } from 'vite-plus/test';

import { handler } from '#maximus/http';

import type { Note } from '../src/notes.ts';

const token = 'test-development-token-for-local-tests';
/** Workers KV for the tests: a Map behind the two methods the notes use. */
const stored = new Map<string, string>();
const env = {
  DEVELOPMENT_TOKEN: token,
  NOTES: {
    get: async (key: string) => stored.get(key) ?? null,
    put: async (key: string, value: string) => {
      stored.set(key, value);
    },
  },
} as unknown as Env;

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

it('writes a note and reads it back', async () => {
  const created = await call('POST', '/v1/notes', { text: 'Call back on Monday.' });
  expect(created).toMatchObject({ status: 201, body: { data: { text: 'Call back on Monday.' } } });
  const note = created.body.data as Note;
  expect((await call('GET', `/v1/notes/${note.noteId}`)).body.data).toEqual(note);
});

it('answers NOTE_NOT_FOUND for a note the organization does not have', async () => {
  expect(await call('GET', `/v1/notes/${crypto.randomUUID()}`)).toMatchObject({
    status: 404,
    body: { error: { code: 'NOTE_NOT_FOUND' } },
  });
});
```

Run the tests:

```sh
bun run test
```

`handler`, from `#maximus/http`, is the Worker's own HTTP handler, generated in `.maximus/`. A test calls it in
Node with a `Request` and an `env` of its own, here a `Map` behind the two KV methods the store uses, so the
whole route runs: token admission, input checks, the handler and the output check. `vp test` prepares the
project as `vp dev` does, which is why the handler accepts a development token from `localhost`.

`bun run verify` runs everything CI runs: the types, lint and format, the tests and the build.

## Deploy

Before the first deployment, set two options in `vite.config.ts`:

- `origin`: the HTTPS URL the Worker is served at. A Worker named `notes` is served at
  `https://notes.<your-subdomain>.workers.dev`, or at a custom domain you route to it.
- `tokens.issuer`: your OAuth authorization server. The deployed Worker accepts the access tokens it issues
  for the origin, and the token's organization and scopes become the `principal`.
  [Authentication and scopes](guides/authentication-and-scopes.md) describes the claims it reads.

Then sign in to Cloudflare and deploy:

```sh
bunx cf auth login
bun run deploy
```

`bun run deploy` verifies the project and deploys the build with `cf deploy`. The first deployment creates the
`NOTES` namespace in your account. From then on, the workflow in `.github/workflows/ci.yml` verifies every pull
request and deploys `main`, given the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## Next steps

- [Concepts](concepts.md) explains the model behind what you built: operations, principals, scopes and
  transports.
- [Routes](guides/routes.md) covers paths, methods, input, responses and files.
- [Bindings](guides/bindings.md) declares D1, R2, queues, Durable Objects and other Workers.
- [MCP](guides/mcp.md) adds tools only agents call, guides and Agent Skills.
- [Testing](guides/testing.md) tests routes, MCP, RPC and a deployed service.
- [`examples/`](../examples) holds deployable services with D1, queues, R2, Browser Run, Durable Objects and
  Worker RPC.
