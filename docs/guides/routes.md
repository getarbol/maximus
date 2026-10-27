# Routes

This guide covers the routes of an API: how a file's name gives its method and path, what its contract
declares, where its input comes from, what it answers, byte uploads and file downloads, limits, and the
OpenAPI document the Worker publishes. Read it when you add a route or change what one accepts.

## A route is a file

Every file of `routes/` is one route. Its folders and its name give its path, and the suffix before `.ts`
gives its method:

| File                                        | Serves                                 |
| ------------------------------------------- | -------------------------------------- |
| `routes/v1/notes/index.get.ts`              | `GET /api/v1/notes`                    |
| `routes/v1/notes/index.post.ts`             | `POST /api/v1/notes`                   |
| `routes/v1/notes/[noteId].get.ts`           | `GET /api/v1/notes/{noteId}`           |
| `routes/v1/notes/[noteId].patch.ts`         | `PATCH /api/v1/notes/{noteId}`         |
| `routes/v1/notes/[noteId].delete.ts`        | `DELETE /api/v1/notes/{noteId}`        |
| `routes/v1/tasks/[taskId]/complete.post.ts` | `POST /api/v1/tasks/{taskId}/complete` |

- The method is `get`, `post`, `put`, `patch` or `delete`. A file named any other way is refused:
  `Name a route file by its method, such as routes/v1/tasks/index.get.ts: routes/v1/notes.ts`.
- `index.<method>.ts` answers its folder's own path, so a collection and its items share one folder.
- `[noteId]` is a path parameter: a whole segment, named by a letter followed by letters, digits and `_`.
  Fixed segments use letters, digits, `_` and `-`.
- Every route lives in a version folder (`v1`, `v2`, …) and names at least one segment below it.
- Each method of a path has one file. Two files that claim it, whatever their parameters are named, are
  refused: `Multiple route files claim GET /v1/notes: routes/v1/notes.get.ts and routes/v1/notes/index.get.ts.`
- A `.dev` or `.prod` suffix after the method keeps a route to one mode: `routes/v1/debug.get.dev.ts` exists
  under `vp dev` and `vp test`, and a `.prod` route only in builds. A mode suffix selects a file; it never
  overrides another file of the same method and path.
- Files whose names start with `_`, and `.test.ts`, `.spec.ts` and `.d.ts` files, are not routes, so helpers
  and tests can sit beside the routes they serve.

A route module default-exports its declaration and nothing else; it may export types beside it. Keep
schemas and helpers in `src/` or in a `_` file. Write the contract as an object, in the call or in a `const`
of the module: `maximus prepare` reads from it, without running the module, whether the route is an MCP
tool, and refuses a contract it cannot read. [Project structure](project-structure.md) describes the other
conventions of `routes/`, such as `(group)` folders.

`maximus gen route` writes a new route file with a handler and a contract to fill in:

```sh
bunx maximus gen route get '/v1/notes/{noteId}' --tool get_note
```

## The API's base path

The routes, the OpenAPI document and the OAuth discovery metadata answer below the API's base path, `/api`
unless `http.basePath` in `maximus()` names another. `/health` and the MCP endpoint, `/mcp`, stay where
they are, and every other path belongs to [pages](#pages) or a [web app](web-apps.md).

```ts
import { maximus } from '@arbol-ai/maximus/vite';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [
    maximus({
      origin: 'https://notes.example.com',
      tokens: { issuer: 'https://auth.example.com/' },
      compatibilityDate: '2026-10-27',
      http: { basePath: '/notes-api' },
    }),
  ],
});
```

The base path is an absolute path without a trailing slash or dot segments, and `/` serves the API at the
root, which a project with a web app cannot do.

A request reaches a route by an exact match of its method and path, before its token is read:

- An unknown path, or a method its path does not serve (`HEAD` and `OPTIONS` included), answers
  `404 NOT_FOUND` without reading the token, so a missing route never reveals whether a caller is
  authorized.
- Paths are not normalized: `/api/v1/notes/` does not match `/api/v1/notes`.
- Each segment is percent-decoded once before it is matched, so `/api/v1/notes/%61rchived` is
  `/api/v1/notes/archived`. A segment that decodes to nothing, `.`, `..`, a slash, a backslash or a control
  character matches no route.
- A fixed segment wins over a parameter in the same place: `routes/v1/notes/archived.get.ts` answers
  `/api/v1/notes/archived`, and `[noteId].get.ts` every other note.

## Declare its contract

A route file default-exports `defineHandler(handler, contract)`. This is the PATCH route of the
[`d1-notes`](../../examples/d1-notes) example:

```ts
// routes/v1/notes/[noteId].patch.ts
import { defineHandler, t, UuidSchema } from '@arbol-ai/maximus';

import { NoteFields, NoteSchema } from '#src/notes.ts';

/** PATCH /api/v1/notes/{noteId}: the note, with its title, its body or both changed. */
export default defineHandler(
  async ({ input, notes, fail }) => {
    const { noteId, ...changes } = input;
    const note = await notes.update(noteId, changes);
    if (!note) {
      return fail('NOTE_NOT_FOUND');
    }
    return note;
  },
  {
    description: 'Change the title, the body or both of a note.',
    input: t.Object(
      { noteId: UuidSchema, title: t.Optional(NoteFields.title), body: t.Optional(NoteFields.body) },
      // Besides the path's id, at least one field to change.
      { additionalProperties: false, minProperties: 2 }
    ),
    output: NoteSchema,
    failures: ['NOTE_NOT_FOUND'],
  }
);
```

The handler receives one object: `input`, decoded and checked against the contract's `input`; `fail`,
which answers a failure of the [error catalog](errors-and-results.md); the verified `principal`; `env`, the
Worker's bindings; and whatever `context.ts` prepares, here `notes`. It returns its output or `fail(code)`,
at once or as a promise. [Context and middleware](middleware-and-context.md) lists everything it receives.

`input` and `output` take a schema, or the fields of a strict object: `{ noteId: UuidSchema }` stands for
`t.Object({ noteId: UuidSchema }, { additionalProperties: false })`. Without `input`, the route takes no
input. Without `output`, it answers the empty object and its handler may return nothing. Without a contract,
both hold.

Every other field is optional, and what a route leaves out is derived from its method and path:

| Field                            | Declares                                                            | Left out                                                     |
| -------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| `description`                    | What the route does: the OpenAPI `description` and the MCP tool's   | None; a route that is an MCP tool must describe itself       |
| `failures`                       | The [domain failures](errors-and-results.md) the route may answer   | Every failure of the catalog                                 |
| `effect`                         | `read`, `write` or `delete`                                         | `read` for GET, `delete` for DELETE, `write` for the others  |
| `scope`                          | The scope a caller's token must hold                                | `<namespace>:<resource>:read` for a read, `:write` otherwise |
| `title`                          | The OpenAPI `summary` and the MCP tool's title                      | The method and path as a sentence: `Update a note`           |
| `operationId`                    | The operation's name                                                | The method and path as an action: `updateNote`               |
| `group`                          | The OpenAPI tag                                                     | The first segment after the version, in words: `Notes`       |
| `mcp`                            | Also serve the route as an [MCP](mcp.md) tool                       | No tool                                                      |
| `rpc`                            | Also serve it as a [native RPC](worker-rpc.md) method               | No RPC method                                                |
| `http`                           | Its success status, a byte body, fields from headers, an attachment | `200`, a JSON body, a JSON answer                            |
| `maxBodyBytes`, `maxOutputBytes` | Its own [limits](#limits)                                           | The application's                                            |
| `visibility`                     | `internal` keeps it out of the OpenAPI document                     | `public`                                                     |

`group`, `actorKinds`, `scopeMatch` and `conditionalScopes` complete the contract. [Route and operation
options](../reference/operations.md#route-contract) gives every field's type, default and rules.

Declare a derived field when its default is wrong. A POST that changes nothing, such as a search that sends
its filters in a body, declares `effect: 'read'` and so takes the read scope. A DELETE route deletes or
writes, never only reads:
`DELETE /v1/notes/{noteId}: a DELETE route deletes; its effect is delete or write, never read.` A delete
takes the write scope.

The resource a default scope names is the first fixed segment after the version, in kebab-case:
`routes/v1/taskLists/[listId].delete.ts` takes `tasks:task-lists:write` in a service whose namespace is
`tasks`. A route whose segments after the version are all parameters names no resource and must declare
its `scope`: `GET /v1/{id}: no fixed segment names its scope; declare its scope.`
[Authentication and scopes](authentication-and-scopes.md) explains what a scope admits.

A contract kept in a `const` keeps its literal types with `satisfies HandlerOptions`; an annotation would
widen them:

```ts
// routes/v1/tasks/[taskId].delete.ts: DELETE /api/v1/tasks/{taskId}
import { defineHandler, UuidSchema } from '@arbol-ai/maximus';
import type { HandlerOptions } from '@arbol-ai/maximus';

const contract = { input: { taskId: UuidSchema } } satisfies HandlerOptions;

export default defineHandler(async ({ input, tasks }) => {
  await tasks.delete(input.taskId);
}, contract);
```

## Input

A route's input is one object. HTTP assembles it from the request, and the shared execution path decodes it
and checks it against the contract's `input` once, on every transport. Nothing is coerced, and a field the
schema does not declare is refused by name:

```json
{
  "success": false,
  "data": null,
  "error": {
    "code": "INVALID_INPUT",
    "message": "The request does not match the published schema.",
    "retryable": false,
    "data": { "issues": [{ "path": "/archived", "message": "Unexpected property" }] }
  },
  "metadata": { "requestId": "…" }
}
```

Before any input is read, the call is admitted: its route matches, its token is verified and holds the
route's scope, and its caller is within the rate limit. A call refused at any of these steps never reaches
your code, and its body is never read. [Concepts](../concepts.md#one-execution-path) describes the whole
path.

### From the path

Each `{name}` of the path is a field of `input`, which the input must declare as a required string, in every
member of a union input; `.build()` refuses
`Path parameter "noteId" must be a required string input field.` otherwise. The field's value is the
decoded segment. The query string and the body may not name the same field, even with the same value: such
a request answers `400 INVALID_INPUT`.

### From the query string

A GET reads its input from the query string. Each field the input declares is read once, as its kind:
`?limit=10&done=true&tags=a,b` is `{ limit: 10, done: true, tags: ['a', 'b'] }`. A list of strings travels as
one comma-separated value, `tags=a,b`, never as a repeated key. The OpenAPI document declares a list
parameter with `style: form` and `explode: false`, so clients generated from it send it this way. A key sent
twice, such as `tags=a&tags=b`, or a value that does not read as its field's kind answers
`400 INVALID_INPUT` without issues. A GET's input is one strict object, never a union. [Query
strings](schemas-and-validation.md#query-strings) gives every rule and shows how to read a field another
way.

### From the body

POST, PUT, PATCH and DELETE read their input from a JSON body:

- The request's `content-type` is `application/json`, whatever its parameters and case; any other, or none,
  answers `415 UNSUPPORTED_MEDIA_TYPE`.
- A body that is not UTF-8 or does not parse as JSON answers `400 INVALID_INPUT`.
- A write sends a body even when its input is empty: a POST without one answers `415` without a
  content type, and `400` with `application/json` and nothing to parse. Send `{}`.
- A DELETE with no body and no `content-type` has the empty input, so a DELETE whose input is all in its
  path sends nothing. A DELETE that does send a body sends JSON.
- In a route with path parameters, the body is a JSON object, to which the path's fields are added.

### From headers

Only a [byte upload](#byte-uploads) reads input fields from request headers.

## Answers

A route answers its output in the envelope, with `200 OK` unless `http.successStatus` says `201` or `202`:

```ts
// routes/v1/tasks/index.post.ts
import { defineHandler } from '@arbol-ai/maximus';

import { TaskSchema, TaskTitleSchema } from '#src/tasks.ts';

/** POST /api/v1/tasks: a new open task, answered with 201 Created. */
export default defineHandler(({ input, tasks }) => tasks.create(input.title), {
  description: 'Add an open task to the organization.',
  input: { title: TaskTitleSchema },
  output: TaskSchema,
  http: { successStatus: 201 },
});
```

```json
{
  "success": true,
  "data": {
    "taskId": "0190c6d4-8f3e-7a6b-9c1d-2e3f4a5b6c7d",
    "title": "Call back",
    "done": false,
    "createdAt": "2026-10-27T07:11:08.277Z"
  },
  "error": null,
  "metadata": { "requestId": "…" }
}
```

What the handler returns is checked against `output` before it leaves; an answer the schema refuses is never
sent, and the caller receives `500 INTERNAL_ERROR` instead. A failure answers with the status its catalog
declares, as [Errors and results](errors-and-results.md) describes. Every response carries `x-request-id`,
`cache-control: private, no-store`, `x-content-type-options: nosniff` and `server-timing`; [Wire
formats](../reference/wire-formats.md#headers) lists each header.

## Byte uploads

A route that receives a file declares `http.body: 'bytes'`, and its handler reads the request's bytes
itself. This is the upload route of the [`r2-documents`](../../examples/r2-documents) example:

```ts
// routes/v1/documents/index.post.ts
import { defineHandler, t } from '@arbol-ai/maximus';

import { DocumentSchema, FilenameSchema, MAX_DOCUMENT_BYTES } from '#src/documents.ts';
import { acceptedFormat } from '#src/formats.ts';

/**
 * POST /api/v1/documents?filename=…: the request's bytes, as a new document of its `content-type`, answered
 * with 201 Created. The bytes are read within the limit, then must match the type before anything is stored.
 */
export default defineHandler(
  async ({ input, body, documents, fail }) => {
    const upload = await body.read();
    if (!upload.ok) {
      return upload.error;
    }
    const bytes = upload.value;
    const format = acceptedFormat(input.contentType, bytes);
    if (!format) {
      return fail('DOCUMENT_NOT_ACCEPTED');
    }
    return documents.create(input.filename, format, bytes);
  },
  {
    description: 'Upload a document: a PDF, PNG, JPEG or UTF-8 text file of at most 10 MiB.',
    input: {
      filename: FilenameSchema,
      contentType: t.String({ maxLength: 255, description: 'The content-type header.' }),
    },
    output: DocumentSchema,
    failures: ['DOCUMENT_NOT_ACCEPTED'],
    http: { body: 'bytes', headers: { contentType: 'content-type' }, successStatus: 201 },
    maxBodyBytes: MAX_DOCUMENT_BYTES,
  }
);
```

- The handler receives `body`, whose `read()` answers the bytes, `{ ok: true, value }` with a `Uint8Array`,
  or the failure to answer as it is, `{ ok: false, error }`. Nothing is read until the handler calls it, so
  a route can check that its target exists first. `read()` reads once; a second call answers the same
  result.
- `read()` holds the body to the route's `maxBodyBytes`. It answers `REQUEST_TOO_LARGE` for a body beyond
  it, by its `content-length` or as its bytes arrive, `UNSUPPORTED_MEDIA_TYPE` for a body whose
  `content-encoding` is anything but `identity`, and `INVALID_INPUT` for a body that breaks off or declares
  a malformed length.
- The rest of the input comes from the path, the query string and the request headers `http.headers` maps,
  input field to header: here the field `contentType` is the `content-type` header. A mapped header is named
  with letters, digits and `-` and is never `authorization`, `cookie`, `host`, `content-length` or
  `content-encoding`, and a mapped field is never a path field. A request that also sends a mapped field in
  its query string, or repeats a query key, answers `400 INVALID_INPUT`.
- A byte upload is never a GET, and it is served over HTTP alone: its contract declares no `mcp` and no
  `rpc`.

The bytes are the route's to judge. The example stores a document only when its bytes start with the
signature of the type it is uploaded as, and R2 checks each upload against the SHA-256 the service
computed.

## Attachments

A route that answers a file declares `output: AttachmentOutputSchema` and `http.response: 'attachment'`, and
returns the file's bytes, media type, name and exact length:

```ts
// routes/v1/documents/[documentId]/content.get.ts
import { AttachmentOutputSchema, defineHandler, UuidSchema } from '@arbol-ai/maximus';

import { MAX_DOCUMENT_BYTES } from '#src/documents.ts';

/**
 * GET /api/v1/documents/{documentId}/content: the document's bytes as an attachment, streamed from R2 with
 * the exact length its metadata states.
 */
export default defineHandler(
  async ({ input, documents, fail }) => {
    const opened = await documents.open(input.documentId);
    if (!opened) {
      return fail('DOCUMENT_NOT_FOUND');
    }
    const { document, body } = opened;
    return {
      body,
      contentType: document.contentType,
      filename: document.filename,
      byteLength: document.byteLength,
    };
  },
  {
    description: 'Download a document of the organization.',
    input: { documentId: UuidSchema },
    output: AttachmentOutputSchema,
    failures: ['DOCUMENT_NOT_FOUND'],
    http: { response: 'attachment' },
    maxOutputBytes: MAX_DOCUMENT_BYTES,
  }
);
```

Before anything is sent, the answer is checked: exactly `body`, `contentType`, `filename` and `byteLength`;
`body` a `Uint8Array` of `byteLength` bytes or an unlocked `ReadableStream`; `contentType` a `type/subtype`
of at most 255 characters; `filename` 1 to 512 characters without control characters, slashes or
backslashes; `byteLength` no more than the route's `maxOutputBytes`. Any other answer is the service's
error, `500 INTERNAL_ERROR`. A stream is sent with exactly `byteLength` bytes: one that carries more or
fewer breaks off with an error.

The response carries the bytes with the success status and `content-type`, `content-length`,
`content-disposition` (the filename in ASCII, and in UTF-8 as `filename*`),
`cache-control: private, no-store`, `content-security-policy: default-src 'none'; sandbox` and
`x-content-type-options: nosniff`. An attachment, like a byte upload, is served over HTTP alone.

## Limits

| Limit        | Default | Set with                                                                                               |
| ------------ | ------- | ------------------------------------------------------------------------------------------------------ |
| Request body | 32 KiB  | `maxBodyBytes` in `maximus()` for every route, or in a route's contract for that route; at most 16 MiB |
| Output       | 256 KiB | `maxOutputBytes` in `maximus()` or in a route's contract; at most 16 MiB                               |

- A JSON body beyond its route's limit answers `413 REQUEST_TOO_LARGE`, refused by its `content-length`
  before it is read, or as soon as its bytes pass the limit. A GET's contract has no `maxBodyBytes`.
- An output is measured as the bytes of its JSON, and an attachment by its `byteLength`. An output beyond its
  limit is the service's error: it answers `500 INTERNAL_ERROR` and is never sent.
- Over MCP, each tool call is held to the limit of the route it calls.

Keep the application's limits small and raise them on the routes that need more, as the document upload
above raises its body limit to 10 MiB. The OpenAPI document publishes each route's limits as
`x-max-body-bytes` and `x-max-output-bytes`.

### Rate limits

A Workers rate limiting binding, named in `maximus()` as `rateLimit`, limits how often each caller calls the
API: a call over the limit answers `429 RATE_LIMITED` before its body is read. [Authentication and
scopes](authentication-and-scopes.md#rate-limits) shows how to declare it.

## Name and hide a route

A route is named after what its method does to what its path names, so it needs no name of its own:

| Route                             | Name                 | Title                |
| --------------------------------- | -------------------- | -------------------- |
| `GET /v1/notes`                   | `listNotes`          | List notes           |
| `POST /v1/notes`                  | `createNote`         | Create a note        |
| `GET /v1/notes/{noteId}`          | `getNote`            | Get a note           |
| `PATCH /v1/notes/{noteId}`        | `updateNote`         | Update a note        |
| `DELETE /v1/notes/{noteId}`       | `deleteNote`         | Delete a note        |
| `POST /v1/notes/{noteId}/archive` | `archiveNote`        | Archive a note       |
| `POST /v1/notes/search`           | `searchNotes`        | Search notes         |
| `GET /v1/notes/{noteId}/summary`  | `getNoteSummary`     | Get note summary     |
| `GET /v1/days/{date}/slots`       | `listDaySlots`       | List day slots       |
| `GET /v1/me/appointments`         | `listMyAppointments` | List my appointments |
| `GET /v2/notes`                   | `listNotesV2`        | List notes (v2)      |

The name is the OpenAPI `operationId`, the native RPC method and the `operation` of the observations
Maximus records; the title is the OpenAPI `summary` and the MCP tool's title; and the first segment after
the version, `Notes`, is the route's `group`, its OpenAPI tag. [Derived names](../reference/operations.md#derived-names)
gives every rule, and `maximus prepare` writes each route's name into `.maximus/app.ts`.

Declare `operationId`, `title` or `group` only where the derived one reads wrong. An `operationId` is a
camelCase name of up to 100 characters that is not a name a Worker entrypoint or a promise already uses,
such as `fetch` or `then`. Two routes that derive one name are refused with both named, so you give one of
them its own:
`Duplicate operation: createNote names both POST /v1/notes and POST /v1/note; give one of them its own operationId.`

`visibility: 'internal'` keeps a route out of the OpenAPI document, and its scopes out of the
`scopes_supported` of the OAuth discovery metadata unless a public route shares them. The route is still
served and still checks its scope, and MCP lists it, as it lists every tool, only to tokens that hold its
scope. Hiding is never authorization: the scope admits the caller.

This route of the [`worker-rpc`](../../examples/worker-rpc) example is named for the Workers that call it
over RPC, and is internal:

```ts
// pricing/routes/v1/quotes.post.ts
import { defineHandler } from '@arbol-ai/maximus';

import { priceItems } from '#src/catalog.ts';
import { ItemsSchema, QuoteSchema } from '#src/quotes.ts';

/**
 * POST /api/v1/quotes, and the RPC method quoteItems the orders Worker calls. Internal: the public OpenAPI
 * document leaves it out, though its scope still admits a caller over HTTP, and openapi.rpc.json, the RPC
 * document its callers bind to, lists it.
 */
export default defineHandler(
  ({ input, fail }) => {
    const priced = priceItems(input.items);
    if (!priced.ok) {
      return fail('UNKNOWN_SKU', { index: priced.unknownIndex });
    }
    return priced.quote;
  },
  {
    description: 'Price a list of catalog items for the calling organization.',
    effect: 'read',
    // The RPC method's name: what it does reads better than the derived createQuote.
    operationId: 'quoteItems',
    input: { items: ItemsSchema },
    output: QuoteSchema,
    failures: ['UNKNOWN_SKU'],
    rpc: true,
    visibility: 'internal',
  }
);
```

## Pages

A file of `pages/` answers a fixed path outside the API, such as `pages/index.ts` for `GET /`, with a plain
`Response` and without a token. A page is no route: it has no contract, answers `GET` and `HEAD`, or the
method its file's name ends with (`pages/webhooks/payments.post.ts` answers `POST`), and is absent from the
OpenAPI document. [Project structure](project-structure.md#pages) gives the paths a page
may take, and [Worker composition](worker-composition.md#pages) what it answers.

## The OpenAPI document

The Worker publishes its API as an OpenAPI 3.1 document at `/api/openapi.json`, and as YAML at
`/api/openapi.yaml` (and `/api/openapi.yml`). Reading it needs no token and grants nothing: every route
still checks its caller. The document is built from the routes and the error catalog when it is first
requested. It holds every public route, without internal routes and tools only MCP serves, each with:

- `operationId`, its name; `summary`, its title; `description`; and `tags`, its group;
- its `security` requirements: the scopes that admit it;
- its path and query parameters, each described, and its JSON body without the path's fields, or the bytes
  it uploads;
- its success response, and one response for each failure status it may answer, naming every code of that
  status with its message;
- its scopes, effect, limits, MCP tool and RPC exposure, as `x-required-scopes`, `x-effect`,
  `x-max-body-bytes`, `x-mcp-tool`, `x-native-rpc` and the other extensions that [Wire
  formats](../reference/wire-formats.md#openapi-extensions) lists.

The server URL is the origin with the base path, `https://notes.example.com/api`, and the paths are the
routes' own, `/v1/notes/{noteId}`. Every schema with an `$id`, such as `UuidSchema` or a note's schema, is
one component of that name, as [Named schemas](schemas-and-validation.md#named-schemas) explains, and so is
every request body, answer and failure: `CreateNoteBody`, `NoteResponse`, `NoteNotFoundFailure` and its
answer `NoteNotFoundError`. [Wire formats](../reference/wire-formats.md#named-components) lists each kind.

`description` and `groups` in `maximus()` describe the service and each group of routes:

```ts
maximus({
  origin: 'https://notes.example.com',
  title: 'Notes',
  description: "The notes of each organization's people, over HTTP and MCP.",
  groups: { Notes: "The notes of the caller's organization." },
});
```

### Generate clients

`bunx maximus openapi` writes the document the Worker serves to `openapi.json`, and
`bunx maximus openapi --check` fails when the routes changed and the file did not; commit the file and run the
check in CI. Any OpenAPI generator reads it, and the clients it writes take the document's names:

```sh
# TypeScript types, for openapi-fetch
bunx openapi-typescript openapi.json -o src/notes-api.d.ts
# Go, Python and other languages
bunx @openapitools/openapi-generator-cli generate -i openapi.json -g go -o notes-go
```

A TypeScript client then knows each answer and each failure by its code:

```ts
import createClient from 'openapi-fetch';

import type { paths } from '#src/notes-api.d.ts';

const notes = createClient<paths>({ baseUrl: 'https://notes.example.com/api', headers: { authorization } });

const { data, error } = await notes.GET('/v1/notes/{noteId}', { params: { path: { noteId } } });
if (error?.error.code === 'NOTE_NOT_FOUND') {
  // getNote answers no other domain failure; INVALID_CURSOR here would not compile.
}
```

The Go client is `NotesAPIService.GetNote(ctx, noteId)`, answering a `*NoteResponse`, and the Python one
`NotesApi.get_note(note_id)`. A list parameter travels as one comma-separated value, `tags=a,b`, which the
document declares with `explode: false`; openapi-fetch sends it so with
`querySerializer: { array: { style: 'form', explode: false } }`.

## Health

`GET /health` answers `{ "status": "ok", "service": "<name>", "version": "<version>" }` without a token.
It probes no dependency: it says that the Worker runs. Any other method answers
`405 HTTP_METHOD_NOT_ALLOWED` with `allow: GET`. `http.healthPath` in `maximus()` moves it to another
absolute path.
