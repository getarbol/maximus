# Adding an operation

## Template

```ts
import { err, ok, t, UuidSchema } from '@arbol-ai/maximus';

import { base, errors } from '../../application';

export const notes = base.operation(
  'getNote', // camelCase, unique; also the OpenAPI operationId and RPC method name
  {
    scope: ['notes:notes:read', 'notes:notes:write'], // any one admits; scopeMatch: 'all' for every one
    effect: 'read', // 'read' | 'write' | 'delete' — truthful; only reads may use GET
    group: 'Notes', // OpenAPI tag
    title: 'Get a note',
    description: 'Read one note by its identifier.', // written for people and models
    input: t.Object({ noteId: UuidSchema }, { additionalProperties: false }),
    output: NoteSchema,
    http: { method: 'GET', path: '/v1/notes/{noteId}' },
    mcp: { name: 'get_note', idempotent: true },
    // rpc: true,
  },
  async ({ env, principal }, input) => {
    const note = await readNote(env.NOTES, principal.organizationId, input.noteId);
    return note ? ok(note) : err(errors.noteNotFound.create());
  }
);
```

### Declared failures

Declare `failures` (the domain codes it may answer) so its documents list only those and any other
domain failure it returns becomes `INTERNAL_ERROR`, reported. Omitted, every failure of the catalog is
listed and allowed; standard failures are always allowed.

```ts
base.operation(
  'archiveNote',
  {
    scope: 'notes:notes:write',
    effect: 'write',
    actorKinds: ['user'],
    title: 'Archive a note',
    description: 'Moves a note out of the active list; it stays readable.',
    input: t.Object({ noteId: UuidSchema }, { additionalProperties: false }),
    output: NoteSchema,
    http: { method: 'POST', path: '/v1/notes/{noteId}/archive' },
    mcp: { name: 'archive_note', idempotent: true },
    failures: ['NOTE_NOT_FOUND'], // the only domain failure it may answer
  },
  async ({ env, principal }, input) => archiveNote(env.NOTES, principal.organizationId, input.noteId)
);
```

Reserved names: `fetch`, `connect`, `constructor`, `then`, `scheduled`, `queue`, `alarm`,
`__proto__`, `prototype`.

## Fields

An inline definition with a field no operation has (a misspelling, a retired `api` name) does not
compile.

| Field | Rule |
| --- | --- |
| `scope` | `<namespace>:<resource>:<action>` with the app's namespace; a list is any-of unless `scopeMatch: 'all'`. |
| `conditionalScopes` | Extra namespaced scopes the handler checks via `context.authority?.scopes`; calls without authority (ordinary RPC) are refused. |
| `actorKinds` | `['user']`, `['service']` or both; omitted, either is admitted. Required on every documented operation under the `oauth+bearer` token scheme. |
| `visibility` | `'internal'`: routed and scope-checked, hidden from OpenAPI, `scopes_supported` and the client. Give it a staff-only scope. |
| `maxBodyBytes` | Per-operation body limit, up to 16 MiB, never on GET. App default 32 KiB. |
| `maxOutputBytes` | Up to 16 MiB. Default 256 KiB. Over the limit → `INTERNAL_ERROR`. |
| `http.method`, `http.path` | `/v<n>/…`, static segments `[A-Za-z0-9_-]+`, whole-segment `{param}`; unique `METHOD path`. |
| `http.successStatus` | `200`, `201` or `202`. |
| `mcp.name` | `^[a-z][A-Za-z0-9_]{0,63}$`, unique; `idempotent` required; `openWorld` defaults to `true`. Served once the Worker mounts `transports: [mcp()]`. |
| `rpc` | `true` (all app callers) or `{ callers }` (a subset). |

## HTTP input rules

- GET input comes from the query string: each declared field is read as its kind (integer, number,
  boolean, comma-separated string list, otherwise string); repeated keys are refused. The typed
  client writes those values the same way.
- POST, PUT, PATCH and DELETE read a JSON body with `content-type: application/json` (415
  otherwise); a DELETE with no body and no `content-type` is the empty input.
- A `{param}` must be a required `string` field of the input (of each union member). The query or
  body may not repeat it.
- Unknown routes and methods are 404 before authentication; no trailing-slash normalization.

## Schemas

- Strict objects or unions of strict objects (discriminated by a field). A GET input is one object.
- Shared, each a named component: `OrganizationIdSchema`, `UuidSchema`, `EmailAddressSchema`,
  `PhoneNumberSchema` (E.164), `HttpsUrlSchema`, `HexColorSchema`, `DeletedObjectSchema`,
  `SignedUrlSchema`, `NamedReferenceSchema`, `PostalAddressSchema`; `EmptyInputSchema` (unnamed). Ids
  are strings; use `organizationId` and `requestId`, never aliases. Name your own entities with a
  PascalCase `$id`, one shape per name: it becomes a public SDK type.
- Lists: `input: inputSchema(t.Object({ ...PageQueryFields, ...filters }, { additionalProperties: false }))`
  (`cursor`, `direction`, `limit`; `limit: pageLimit({ maximum })` to lower it) and
  `output: Page(Item, { $id: 'ItemPage' })`, answering `{ object: 'list', data, pageInfo }`.
- Formats: `date`, `time`, `date-time` (time zone required), `email`, `uuid`, `uri`.
- Use `t.Union([X, t.Null()])` for absent values in outputs; present every field.

## Codecs (from `@arbol-ai/maximus/schemas`)

```ts
import { defaultSchema, inputSchema, normalizeSchema, refineSchema, t } from '@arbol-ai/maximus/schemas';

input: inputSchema(
  refineSchema(
    t.Object(
      {
        query: normalizeSchema(t.String({ minLength: 1, maxLength: 100 }), (value) => value.trim()),
        limit: defaultSchema(t.Integer({ minimum: 1, maximum: 50 }), 20),
        from: t.String({ format: 'date' }),
        to: t.String({ format: 'date' }),
      },
      { additionalProperties: false }
    ),
    (value) => value.from <= value.to,
    { message: 'The range must not end before it starts.', path: ['to'] }
  )
),
```

- Without `inputSchema(...)` around the input, normalizers, transforms, refinements and stripping do
  not run.
- Handlers receive `StaticDecode<typeof input>`; clients and OpenAPI see `Static<typeof input>`.
- Refinement messages travel to callers in `INVALID_INPUT` issues: never include input values.
- Other helpers: `transformSchema`, `inspectSchema` (several issues via `addIssue`), `pipeSchema`,
  `stripObject` / `strictObject` / `looseObject` / `extendObject`, `literalUnion`, `urlSchema`.

Numbers in a GET query need a wire schema:

```ts
const Query = t.Object(
  {
    limit: t.Optional(
      t.Transform(t.String({ pattern: '^[1-9][0-9]{0,2}$' })).Decode((v) => Number(v)).Encode((v) => String(v))
    ),
  },
  { additionalProperties: false }
);
const Canonical = t.Object({ limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false });
// input: inputSchema(Canonical, Query)
```

## Context, derive and use

Handler context: `env`, `principal` (`actorId`, `actorKind`, `organizationId`, `requestId`),
`authority` (`{ surface, scopes, client, token? }`, frozen; absent over ordinary RPC), `input`,
`operation`, `background` (`waitUntil`, best effort), and `body` for byte uploads.

```ts
const connected = base.derive(async ({ env, principal }) => {
  const account = await loadAccount(env, principal.organizationId);
  return account ? ok({ account }) : err(errors.accountNotConnected.create());
});
export const reports = connected.operation('listReports', definition, async ({ account }, input) => …);
```

- `.derive()` must precede `.operation()` on its chain (it throws otherwise); it runs after
  admission and input validation; its failure ends the call.
- `.use(async (context, proceed) => …)`: call `proceed()` at most once and return its `Result`, or
  return your own. Results are validated. Applies to operations declared after it.
- Operations that set something up (a connection) must not sit in the group that requires it.
- `mount` only builders from the same `maximus()` base.

## Files

Upload: `http: { method: 'PUT', path: '/v1/notes/{noteId}/attachment', body: 'bytes', headers: { contentType: 'content-type' } }`,
a `maxBodyBytes`, and `const bytes = await context.body.read()` (a `Result`, read once) after checking
the target resource. Download: `output: AttachmentOutputSchema`, `http: { …, response: 'attachment' }`,
return `ok({ body, contentType, filename, byteLength })`. Both are HTTP-only.

## Before you finish

- Scopes namespaced; effect truthful; strict schemas; every failure from the app's catalog.
- No organization in the input; tenant keys built from `principal.organizationId`.
- Provider and storage reads go through `checkSchema`/`readSchema`.
- Typecheck, tests and lint pass; `.build()` raises no `TypeError`.
