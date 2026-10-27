# Routes and tools

## A route is a file

A file of `routes/` declares one operation; its name gives its path and method, below the API's base path,
`/api` by default:

| File                                       | Serves                                |
| ------------------------------------------ | ------------------------------------- |
| `routes/v1/notes.post.ts`                  | `POST /api/v1/notes`                  |
| `routes/v1/notes/index.get.ts`             | `GET /api/v1/notes`                   |
| `routes/v1/notes/[noteId].get.ts`          | `GET /api/v1/notes/{noteId}`          |
| `routes/v1/notes/[noteId]/archive.post.ts` | `POST /api/v1/notes/{noteId}/archive` |

- The method is `get`, `post`, `put`, `patch` or `delete`, before the extension. Every route lives below a
  version folder, `routes/v1/`.
- `[name]` is a parameter that fills a whole segment; a folder in parentheses, `(admin)`, groups files
  without changing the path.
- `<name>.dev.ts` exists in development alone (`vp dev` and `vp test`) and `<name>.prod.ts` in builds alone. Files that start with `_`
  or `.`, and `*.test.ts`, `*.spec.ts` and `*.d.ts` files, are not routes.
- `prepare` refuses two files for one method whose paths differ only in a parameter's name, and a file
  without a method.

`bunx maximus gen route post /v1/notes` writes the file with a placeholder handler; `--tool <snake_name>`
makes it an MCP tool too.

```ts
// routes/v1/notes/[noteId].get.ts
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

## What a route derives

What the contract leaves out, binding derives from the method and the path:

| Field            | Derived                                                                                                                                 | For the file above |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Operation name   | The method and the path's segments, in camelCase: the `operationId` and the RPC method.                                                 | `getV1NotesNoteId` |
| `effect`         | `GET` reads, `DELETE` deletes, every other method writes.                                                                               | `read`             |
| `scope`          | `<namespace>:<resource>:read` for a read, `:write` otherwise; the resource is the first fixed segment after the version, in kebab-case. | `notes:notes:read` |
| `title`          | The tool's name, humanized, or else the method and path.                                                                                | `Get note`         |
| `mcp.idempotent` | `true` for `GET`, `PUT` and `DELETE`.                                                                                                   | `true`             |

A route whose path has no fixed segment after the version must declare its `scope`. A `DELETE` never declares
`effect: 'read'`, and only a read may use `GET`.

## The handler

`defineHandler(handler, contract)` takes the handler first. The handler receives one object:

- `input`: decoded and checked against the contract's `input`, path parameters included.
- `fail(code, data?)`: answers a failure of the catalog; only the route's `failures` and the standard codes
  type-check.
- `principal`: `{ actorId, actorKind, organizationId, requestId }`, the verified caller.
- `env`: the Worker's bindings.
- `authority`: the verified token's `{ surface, scopes, client, token }`, on HTTP and MCP calls whose token
  names a client; absent over RPC.
- `background`: `waitUntil` for best-effort work after the answer.
- `body`: on a byte route, the body's reader.
- Whatever `context.ts` returns.

It answers its output, or `fail(code)`, directly or as a promise. A route without `output` answers the empty
object, and its handler may return nothing.

## The contract

| Field                            | Meaning                                                                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `input`, `output`                | A schema, or the fields of a strict object: `{ noteId: UuidSchema }`. Without `input`, the route takes none.                            |
| `description`                    | What it does, for people and agents. Required on a route that is an MCP tool.                                                           |
| `title`, `group`                 | The OpenAPI summary and tag.                                                                                                            |
| `operationId`                    | Its name instead of the derived one: the `operationId` and the RPC method.                                                              |
| `scope`, `scopeMatch`            | One scope or several, `<namespace>:<resource>:<action>`; several admit any one unless `scopeMatch: 'all'`.                              |
| `conditionalScopes`              | Scopes the handler checks itself against `authority.scopes`; a call without `authority`, such as over RPC, is refused with `FORBIDDEN`. |
| `effect`                         | `read`, `write` or `delete`. It shapes the default scope and MCP hints; it never authorizes.                                            |
| `failures`                       | The domain codes it may answer. Any other answers `INTERNAL_ERROR` and is reported.                                                     |
| `actorKinds`                     | `['user']`, `['service']` or both; every kind when omitted.                                                                             |
| `visibility`                     | `'internal'` keeps it out of the public OpenAPI document and the discovery metadata; it stays routed and scope-checked.                 |
| `http`                           | `successStatus` (200, 201 or 202), `body: 'bytes'`, `headers`, `response: 'attachment'`.                                                |
| `mcp`                            | `{ name, idempotent?, openWorld? }`: also an MCP tool. `openWorld` is `true` unless declared.                                           |
| `rpc`                            | `true` for every caller in `rpc.callers`, or `{ callers }` for some of them.                                                            |
| `maxBodyBytes`, `maxOutputBytes` | Its own limits, up to 16 MiB; the application's (32 KiB and 256 KiB) otherwise.                                                         |

A field no operation has does not compile, and `.build()` refuses it. A contract kept in a `const` keeps
its types with `satisfies HandlerOptions`.

## Input

- **Path parameters** are required string fields of the input. The query string or the body may not repeat
  them.
- **A `GET`** reads its input from the query string: each field as its schema's kind (integer, number,
  boolean, a comma-separated list of strings, else a string). A repeated key is refused, and so is a field
  named `__proto__`.
- **`POST`, `PUT`, `PATCH` and `DELETE`** read a JSON body sent as `application/json`; another media type
  answers `UNSUPPORTED_MEDIA_TYPE`. A `DELETE` without a body or `content-type` takes the empty input.
- A refused input answers `INVALID_INPUT`, with up to ten `{ path, message }` issues and never the value.

## Schemas

Schemas are TypeBox's, imported as `t` from `@arbol-ai/maximus` (or `@arbol-ai/maximus/schemas`, which
browsers can import):

- Inputs and outputs are strict objects (`additionalProperties: false`) or unions of strict objects. Name a
  shared entity with a PascalCase `$id`, one shape per name: `NoteSchema` with `$id: 'Note'`.
- The shared schemas: `UuidSchema`, `OrganizationIdSchema`, `EmailAddressSchema`, `PhoneNumberSchema`,
  `HttpsUrlSchema`, `HexColorSchema`, `PostalAddressSchema`, `NamedReferenceSchema`, `SignedUrlSchema`,
  `DeletedObjectSchema`, `EmptyInputSchema`.
- Absent values in an output are `t.Union([X, t.Null()])`: answer every field.
- Codecs from `@arbol-ai/maximus/schemas` (`normalizeSchema`, `transformSchema`, `refineSchema`,
  `inspectSchema`, `pipeSchema`, `stripObject`) run only inside `inputSchema(…)`; `.build()` refuses an input
  that uses them outside it. `defaultSchema` gives a field its default. A refinement's message reaches the
  caller: never put a value in it.
- Read data that comes from outside the pipeline with `readSchema(schema, value)`, which throws on a value
  that does not match, or `checkSchema(schema, value)`, which answers `{ success, data }` or
  `{ success: false, error }`.

[Schemas and validation](https://github.com/getarbol/maximus/blob/main/docs/guides/schemas-and-validation.md)
covers codecs, query strings and named schemas.

## Lists

A route that answers many items answers one page of them:

```ts
// routes/v1/notes/index.get.ts
import { defineHandler, Page, PageQueryFields } from '@arbol-ai/maximus';

import { NoteSchema } from '../../../src/notes.ts';

export default defineHandler(
  async ({ input, notes, fail }) => (await notes.page(input)) ?? fail('INVALID_CURSOR'),
  {
    description: "List the organization's notes, newest first. Pass pageInfo.nextCursor as cursor for more.",
    input: PageQueryFields,
    output: Page(NoteSchema, { $id: 'NotePage' }),
    failures: ['INVALID_CURSOR'],
  }
);
```

`PageQueryFields` are `cursor`, `direction` (`forward` or `backward`) and `limit` (25 by default, at most
100; `pageLimit({ maximum })` lowers it). The answer is `{ object: 'list', data, pageInfo }`, whose
`pageInfo` holds `hasNextPage`, `hasPreviousPage`, `nextCursor` and `previousCursor`. Spread the fields
beside a list's own filters: `{ ...PageQueryFields, text: t.String() }`.

## Byte bodies and attachments

An upload declares `http: { body: 'bytes' }`. Its input comes from the path, the query string and the
headers its `http.headers` maps, and the handler reads the body when it has checked the request:

```ts
async ({ input, body, documents, fail }) => {
  const bytes = await body.read();
  if (!bytes.ok) {
    return bytes.error; // REQUEST_TOO_LARGE, UNSUPPORTED_MEDIA_TYPE or INVALID_INPUT
  }
  return documents.create(input.filename, input.contentType, bytes.value);
},
// contract: http: { body: 'bytes', headers: { contentType: 'content-type' }, successStatus: 201 }
```

A download declares `output: AttachmentOutputSchema` and `http: { response: 'attachment' }`, and answers
`{ body, contentType, filename, byteLength }`. Both are HTTP alone: never an MCP tool or an RPC method.

## Tools only agents call

A file of `mcp/tools/`, named in kebab-case, default-exports `defineTool(handler, contract)`:

```ts
// mcp/tools/search-notes.ts: the tool search_notes, operation searchNotes
import { defineTool, t } from '@arbol-ai/maximus';

import { NoteSchema } from '../../src/notes.ts';

export default defineTool(async ({ input, notes }) => ({ notes: await notes.search(input.text, 20) }), {
  description: "Find the organization's notes whose text contains a word, newest first, at most twenty.",
  effect: 'read',
  input: { text: t.String({ minLength: 2, maxLength: 100 }) },
  output: { notes: t.Array(NoteSchema) },
});
```

A tool requires `description` and `effect`. Its default scope is `<namespace>:<file name>:read` for a read and
`:write` otherwise, it is idempotent only for a read unless `idempotent` says so, and it has no HTTP route.
`bunx maximus gen tool search-notes` writes the file.

## Context and middleware

`context.ts` prepares what every handler receives, after admission:

```ts
import { defineContext } from '@arbol-ai/maximus';

import { noteStore } from './src/notes.ts';

export default defineContext(({ env, principal }) => ({
  notes: noteStore(env.NOTES, principal.organizationId),
}));
```

A file of `middleware/` default-exports one of two declarations from `@arbol-ai/maximus/config`, and the
files run in the order of their names:

- `defineMiddleware((request, env, context, proceed) => …)` wraps every request before its token is read. It
  sees a copy of the request without its body and no principal; it adds headers or answers the request
  itself. It never admits a caller.
- `defineOperationMiddleware<PreparedContext<typeof context>>((context, proceed) => …)` runs around every
  route and tool on HTTP, MCP and RPC, after admission and `context.ts`. It answers `proceed()`'s `Result` or
  its own (`err(standardErrors.forbidden.create())`); the answer is checked as a handler's is.

`proceed()` runs once. See
[Context and middleware](https://github.com/getarbol/maximus/blob/main/docs/guides/middleware-and-context.md),
[Routes](https://github.com/getarbol/maximus/blob/main/docs/guides/routes.md) and
[Route and operation options](https://github.com/getarbol/maximus/blob/main/docs/reference/operations.md).
