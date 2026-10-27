# Schemas and validation

Contracts are [TypeBox](https://github.com/sinclairzx81/typebox) schemas. This guide covers writing them, the
schemas Maximus exports for the values every service shares, lists, the codecs that normalize and refine
input, query strings, named schemas, and reading data back from storage. Read it when you write a contract,
or when a handler reads data it did not receive as input.

## Write a schema

```ts
// src/tasks.ts
import { t, UuidSchema } from '@arbol-ai/maximus';
import type { Static } from '@arbol-ai/maximus';

/** A task as it is stored and answered. */
export const TaskSchema = t.Object(
  {
    taskId: UuidSchema,
    title: t.String({ minLength: 1, maxLength: 200 }),
    done: t.Boolean(),
    completedAt: t.Union([t.String({ format: 'date-time' }), t.Null()]),
  },
  { $id: 'Task', additionalProperties: false }
);
/** A task. */
export type Task = Static<typeof TaskSchema>;
```

`t` is TypeBox's `Type`, exported by `@arbol-ai/maximus` and by `@arbol-ai/maximus/schemas`. A schema is the
check a value passes at runtime, the value's TypeScript type through `Static`, and its description in the
OpenAPI document and the MCP tool listing, as [Concepts](../concepts.md#schemas) explains.

- A contract's `input` and `output` are strict objects (`additionalProperties: false`), or unions whose every
  member is one, told apart by a field such as `kind`. A GET's input is one strict object, its query string.
  `.build()` refuses anything else:
  `Operation "createNote": input and output are strict objects or unions of strict objects; a GET input is one strict object (its query). Use safe operation names, namespaced scopes and strict object schemas.`
  The fields a route gives as `input` or `output`, `{ title: t.String() }`, make a strict object.
- `.build()` checks the outermost object. Declare nested objects strict as well, or their unknown fields are
  admitted.
- The formats `date`, `time`, `date-time`, `email`, `uuid` and `uri` are checked by maintained RFC
  validators, without generating code at runtime. `time` and `date-time` require a time zone. A value longer
  than 8192 characters fails any format, and a format outside this list refuses every value.
- Ids are strings. The organization is `organizationId`, and a request's id `requestId`.
- An output states every field. Declare "no value" as a union with `t.Null()` rather than leaving the field
  out.

## Shared schemas

Values and objects that every service publishes alike carry an `$id`, so the OpenAPI document holds each
once as a component of that name, and every client generated from those documents has one type for it:

| Export                                  | Component                    | Shape                                                                                                                                           |
| --------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `UuidSchema`                            | `Uuid`                       | A lowercase RFC 9562 UUID of version 1 to 8                                                                                                     |
| `OrganizationIdSchema`                  | `OrganizationId`             | 1 to 128 letters, digits, `_` and `-`, starting with a letter or a digit: the ids identity providers issue (`org_…`, UUIDs, slugs)              |
| `EmailAddressSchema`                    | `EmailAddress`               | Format `email`, at most 254 characters                                                                                                          |
| `PhoneNumberSchema`                     | `PhoneNumber`                | E.164: `+` and 2 to 15 digits, the first not `0`                                                                                                |
| `HttpsUrlSchema`                        | `HttpsUrl`                   | Format `uri`, starting with `https://`, at most 2048 characters                                                                                 |
| `HexColorSchema`                        | `HexColor`                   | `#rrggbb`                                                                                                                                       |
| `DeletedObjectSchema`                   | `DeletedObject`              | `{ id: string, deleted: true }`: what a delete answers                                                                                          |
| `SignedUrlSchema`                       | `SignedUrl`                  | `{ url: HttpsUrl, expiresAt: date-time }`: a link that grants access by itself until it expires                                                 |
| `NamedReferenceSchema`                  | `NamedReference`             | `{ id: string, name: string }`                                                                                                                  |
| `PostalAddressSchema`                   | `PostalAddress`              | Shaped as FHIR `Address`: `{ line?, city?, state?, postalCode?, countryCode?, use? }`, `countryCode` ISO 3166-1 alpha-2, `use` `home` or `work` |
| `PageInfoSchema`, `Page(item, { $id })` | `PageInfo`, the page's `$id` | See [Lists](#lists)                                                                                                                             |
| `FailureSchema`                         | `Failure`                    | `{ code, message, retryable, data }`: the base every failure narrows                                                                            |
| `EmptyInputSchema`                      | None                         | `{}`, strict                                                                                                                                    |
| `AttachmentOutputSchema`                | None                         | The output of a route that answers a file; see [Attachments](routes.md#attachments)                                                             |

The package root and `@arbol-ai/maximus/schemas` export them all, except `FailureSchema`, which the root and
`@arbol-ai/maximus/errors` export.

Use them as they are. To give a field its own description, spread the schema:
`{ ...EmailAddressSchema, description: 'Where the receipt goes.' }` keeps the reference to `EmailAddress` and
adds the description beside it. Your own records are named by an `$id` of their own, as `TaskSchema` is.

## Lists

Every list has one contract: keyset pages with an opaque cursor, and no page number, offset or total. Its
input takes `PageQueryFields`, beside the list's own filters, and its output is a `Page`:

```ts
// src/notes.ts
import { Page, t, UuidSchema } from '@arbol-ai/maximus';

/** A note as it is stored and answered. */
export const NoteSchema = t.Object(
  {
    noteId: UuidSchema,
    title: t.String({ minLength: 1, maxLength: 200 }),
    body: t.String({ maxLength: 10_000 }),
    createdAt: t.String({ format: 'date-time' }),
    updatedAt: t.String({ format: 'date-time' }),
  },
  { $id: 'Note', additionalProperties: false }
);

/** One page of the organization's notes, newest first. */
export const NotePageSchema = Page(NoteSchema, { $id: 'NotePage' });
```

```ts
// routes/v1/notes/index.get.ts
import { defineHandler, PageQueryFields } from '@arbol-ai/maximus';

import { NotePageSchema } from '#src/notes.ts';

/** GET /api/v1/notes, also the MCP tool list_notes: the organization's notes, a page at a time. */
export default defineHandler(
  async ({ input, notes, fail }) => {
    const page = await notes.list(input);
    if (!page) {
      return fail('INVALID_CURSOR');
    }
    return page;
  },
  {
    description:
      "List the organization's notes, newest first, a page at a time. To read the next page, pass this page's pageInfo.nextCursor as cursor.",
    input: PageQueryFields,
    output: NotePageSchema,
    failures: ['INVALID_CURSOR'],
    mcp: { name: 'list_notes' },
  }
);
```

- The query takes `cursor`, the opaque cursor of a previous page, absent for the first; `direction`,
  `forward` or `backward` from that cursor, `forward` by default; and `limit`, an integer from 1 to 100,
  25 by default. Spread the fields beside the list's own:
  `t.Object({ ...PageQueryFields, done: t.Optional(t.Boolean()) }, { additionalProperties: false })`.
- Decoding applies the defaults before the handler runs, so it always receives `direction` and `limit` (the
  type `PageQuery`), and the OpenAPI document and the MCP tool listing publish both as optional, since a
  caller may leave them out. Wrapping the input in `inputSchema()` changes neither.
- `pageLimit()` gives a list whose items are costly a lower maximum:
  `{ ...PageQueryFields, limit: pageLimit({ maximum: 20 }) }`. Its default becomes the smaller of 25 and the
  maximum, unless you pass `default`. It refuses
  `A page limit has an integer default from 1 to its integer maximum.` otherwise.
- The output is `{ object: 'list', data, pageInfo }`, where `pageInfo` holds `hasNextPage`,
  `hasPreviousPage`, `nextCursor` and `previousCursor`, each cursor a string or `null`. [Wire
  formats](../reference/wire-formats.md#lists) gives the exact schemas.
- A cursor the list did not issue is the service's own failure to answer, such as the `INVALID_CURSOR` of
  the [`d1-notes`](../../examples/d1-notes) example.

`PageInfo` and each page are named schemas, so the OpenAPI document holds each once. That makes a page's
name public: `Page` takes a PascalCase name, conventionally the item's and `Page`, and refuses any other
(`Page "notePage" needs a PascalCase schema name, such as AppointmentPage.`). Give each list its own name:
two different pages under one name become two components, the second suffixed `_2`.

## Input codecs

A codec gives a field an owner's meaning on its way in: a default, a normalization, a conversion or a rule.
The codecs live in `@arbol-ai/maximus/schemas`, and `inputSchema()` compiles them into the input the
execution path decodes:

```ts
// src/search.ts
import { defaultSchema, inputSchema, normalizeSchema, refineSchema, t } from '@arbol-ai/maximus/schemas';

const SearchSchema = t.Object(
  {
    query: normalizeSchema(t.String({ minLength: 1, maxLength: 100 }), (query) => query.trim()),
    limit: defaultSchema(t.Integer({ minimum: 1, maximum: 50 }), 20),
    from: t.String({ format: 'date' }),
    to: t.String({ format: 'date' }),
  },
  { additionalProperties: false }
);

/** A search of the organization's notes: trimmed text, at most 50 notes, a range that does not end early. */
export const SearchInputSchema = inputSchema(
  refineSchema(SearchSchema, (search) => search.from <= search.to, {
    message: 'The range must not end before it starts.',
    path: ['to'],
  })
);
```

```ts
// routes/v1/notes/search.post.ts
import { defineHandler, t } from '@arbol-ai/maximus';

import { NoteSchema } from '#src/notes.ts';
import { SearchInputSchema } from '#src/search.ts';

/** POST /api/v1/notes/search: the organization's notes that contain a text. */
export default defineHandler(
  async ({ input, notes }) => {
    const matchingNotes = await notes.search(input.query, input.limit);
    return { notes: matchingNotes };
  },
  {
    description: "Find the organization's notes that contain a text.",
    effect: 'read',
    input: SearchInputSchema,
    output: { notes: t.Array(NoteSchema) },
  }
);
```

`{ "query": "  call back  ", "from": "2026-10-01", "to": "2026-10-31" }` reaches the handler as
`{ query: 'call back', limit: 20, from: '2026-10-01', to: '2026-10-31' }`. A range that ends before it starts
answers `INVALID_INPUT` with this issue:

```json
{ "path": "/to", "message": "The range must not end before it starts." }
```

Wrap every input that uses a codec in `inputSchema()`: a plain decode would apply TypeBox's checks and
defaults and skip the rest, so `.build()` refuses such an input:
`Operation "searchNotes": its input uses codecs (normalize, transform, inspect, refine, pipe or stripObject) that run only inside inputSchema(); wrap the input in inputSchema().`

| Helper                                              | Effect                                                                                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inputSchema(schema)`                               | Compiles the codecs below into one input schema. A field with a default is optional on the wire.                                                     |
| `inputSchema(schema, wire)`                         | Reads another shape, `wire`, then checks and decodes the result as `schema`. See [Query strings](#query-strings).                                    |
| `inputSchema(schema, { stripUnknown: true })`       | Drops the unknown keys of `stripObject` objects instead of refusing them, for readers of stored data. `.build()` refuses it as an operation's input. |
| `defaultSchema(schema, value)`                      | A default the field takes when it is absent.                                                                                                         |
| `normalizeSchema(schema, fn)`                       | Runs `fn` on the value, then checks the result's length, pattern and format. Consecutive normalizers all run before those checks.                    |
| `transformSchema(schema, fn)`                       | Checks the value against `schema`, then converts it with `fn`.                                                                                       |
| `refineSchema(schema, predicate, detail?)`          | Refuses a value `predicate` rejects; `detail` is a message, or `{ message, path }`.                                                                  |
| `inspectSchema(schema, (value, { addIssue }) => …)` | Like `refineSchema`, reporting any number of issues.                                                                                                 |
| `pipeSchema(source, target)`                        | Reads the value as `source`, then checks and decodes the result as `target`.                                                                         |
| `stripObject(properties)`                           | A strict object whose unknown keys a reader that strips drops.                                                                                       |
| `strictObject(schema)`, `looseObject(schema)`       | An object that refuses unknown keys even where a read strips them; one that admits and keeps them.                                                   |
| `extendObject(object, properties)`                  | The object with more properties, treating unknown keys as it does.                                                                                   |
| `literalUnion(['open', 'done'])`                    | A union of literals.                                                                                                                                 |
| `urlSchema({ protocol, hostname?, maxLength? })`    | A `uri` whose protocol, and hostname when given, match the expressions.                                                                              |

Codecs run in the order they are declared. A refinement's message reaches the caller in the issues of
`INVALID_INPUT`, so it never contains the input's values. A codec that throws anything but a refusal is the
service's error: the call answers `INTERNAL_ERROR`.

A codec gives an input two types: what callers send, which the OpenAPI document publishes, and what the
handler receives, `StaticDecode<typeof schema>` from `@arbol-ai/maximus/schemas`. Without codecs, the two
are `Static<typeof schema>`.

Outputs are checked, never decoded: a handler returns the canonical value, defaults included. Keep the
canonical schema for outputs and build inputs from it, so an output check never repairs malformed data.

## Query strings

A GET reads its input from the query string, each field the input declares once, as its kind:

| A field declared as                                      | Is read as                                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| An integer                                               | A decimal integer of at most 16 digits, without leading zeros: `limit=10`, `offset=-2` |
| A number                                                 | A decimal, with an optional fraction and exponent: `ratio=0.25`, `ratio=-1.5e3`        |
| A boolean                                                | `true` or `false`                                                                      |
| A list of strings, or a list or a string                 | Comma-separated items, none empty: `tags=a,b` is `['a', 'b']`, and `tags=a` is `['a']` |
| A string, a string literal or a union of string literals | The text as it is                                                                      |

- A value that does not read as its kind (`limit=010`, `ratio=.5`, `done=yes`, `tags=a,,b`), a repeated key
  and the key `__proto__` answer `400 INVALID_INPUT`, without issues. A list is one comma-separated value,
  which the OpenAPI document declares with `style: form` and `explode: false`: `tags=a&tags=b` is refused.
- A `null` alternative is ignored: `t.Union([t.Integer(), t.Null()])` reads as an integer.
- Any other field (an object, a list of numbers, a tuple, a union of different kinds such as an integer or
  `'all'`) has no query kind. Its value stays text, which its schema refuses unless it admits text.
- A key the input does not declare stays text too, and the strict input refuses it as `Unexpected property`.

To read a field another way, declare the shape it travels in, its wire schema, beside the input the handler
receives, and join them with `inputSchema(input, wire)`. A wire field declared as a string stays a string,
and its transform decodes it:

```ts
// src/task-queries.ts
import { inputSchema, t } from '@arbol-ai/maximus/schemas';

/** The query as it travels: priorities as comma-separated digits, `?priority=1,3`. */
const ListTasksQuery = t.Object(
  {
    priority: t.Optional(
      t
        .Transform(t.String({ pattern: '^[1-5](,[1-5])*$' }))
        .Decode((text) => text.split(',').map(Number))
        .Encode((priorities) => priorities.join(','))
    ),
  },
  { additionalProperties: false }
);

/** The input the handler receives: `{ priority: [1, 3] }`. */
const ListTasksInput = t.Object(
  { priority: t.Optional(t.Array(t.Integer({ minimum: 1, maximum: 5 }), { maxItems: 5 })) },
  { additionalProperties: false }
);

/** The input of `GET /v1/tasks`: the query as it travels, decoded into what the handler receives. */
export const ListTasksInputSchema = inputSchema(ListTasksInput, ListTasksQuery);
```

The pattern belongs to the wire schema, and the bounds to the input. The OpenAPI document publishes the wire
schema, callers send text, and the handler receives numbers.

## Named schemas

A schema with an `$id` is named. The OpenAPI document holds it once, as the component of that name, and
every use of it is a reference, `{ "$ref": "#/components/schemas/Note" }`, beside which a description given
at the use stays. The shared schemas and every page are named; name your own records the same way.

- A name is public, so it names one shape. Two different schemas under one `$id` become two components, the
  second suffixed `_2`, and clients generated from the document see two types.
- An MCP tool's schemas are self-contained, as MCP clients compile them: each named schema is written where it
  is used, without its `$id`, and a definition that a reference names is written once under `$defs`.
- `t.Ref('Note')` refers to a schema by its name, and a recursive schema (`t.Recursive`) to itself. A
  reference made outside the schema it names resolves only when that name has exactly one definition among
  the application's schemas, which `.build()` checks before the service starts:
  `Schema reference "Note" does not name exactly one definition.`

## Reading untrusted data

Data that is not an operation's input still crosses a boundary: a stored record, a provider's or a model's
answer, a file. Read it through its schema with `readSchema` or `checkSchema`, from
`@arbol-ai/maximus/schemas`:

```ts
// src/task-reader.ts
import { readSchema } from '@arbol-ai/maximus/schemas';

import { TaskSchema } from './tasks.ts';
import type { Task } from './tasks.ts';

/** The organization's task with this id, or undefined when it has none. */
export async function findTask(
  namespace: KVNamespace,
  organizationId: string,
  taskId: string
): Promise<Task | undefined> {
  const stored = await namespace.get(`tasks/${organizationId}/${taskId}`);
  if (stored === null) {
    return undefined;
  }
  return readSchema(TaskSchema, JSON.parse(stored));
}
```

`readSchema` answers the decoded value, or throws a `SchemaValidationError` that lists every issue,
`{ code, message, path }`. Thrown in a handler, it answers `INTERNAL_ERROR`: a record that does not match its
schema is never answered as one. `checkSchema` answers `{ success: true, data }` or
`{ success: false, error }` with that same error instead, for a refusal the code handles itself, as the
queue consumer of the [`queue-reminders`](../../examples/queue-reminders) example does with a message the
service never sends:

```ts
const checked = checkSchema(ReminderMessageSchema, message.body);
if (!checked.success) {
  // Retrying a message this service never sends cannot make it succeed.
  reportUnexpected(checked.error, 'queue');
  message.ack();
  return;
}
const { organizationId, reminderId } = checked.data;
```

Both apply the schema's codecs: defaults, normalizers before their checks, refinements, and the unknown keys
of `stripObject` objects dropped, so a record stored with a field the service does not read still reads:

```ts
import { readSchema, stripObject, t, UuidSchema } from '@arbol-ai/maximus/schemas';

const StoredNoteSchema = stripObject({ noteId: UuidSchema, text: t.String() });

// { noteId: '0190c6d4-8f3e-7a6b-9c1d-2e3f4a5b6c7d', text: 'Call back' }
const note = readSchema(StoredNoteSchema, {
  noteId: '0190c6d4-8f3e-7a6b-9c1d-2e3f4a5b6c7d',
  text: 'Call back',
  color: 'blue',
});
```

Neither coerces a value, and both admit only a plain JSON tree: no class instances such as a `Date`, no
cycles, no numbers that are not finite and no nesting deeper than 100 levels. Turn a date into its string
first, as the [`r2-documents`](../../examples/r2-documents) example reads `object.uploaded.toISOString()`.

| Helper                        | Answers                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `parseInput(schema, value)`   | A check without defaults or codecs: `{ ok: true, value }`, or an `INVALID_INPUT` failure without issues.     |
| `parseSchema(schema, value)`  | The same check, answering the value or throwing a `TypeError` that names no value.                           |
| `decodeInput(schema, value)`  | The execution path's decoding as a function: the value, or an `INVALID_INPUT` failure with up to ten issues. |
| `decodeSchema(schema, value)` | The same decoding, throwing its refusal.                                                                     |

`parseInput` and `parseSchema` are also exported by the package root.

Read a provider's answer within a byte limit before checking it.
`readJsonResponse(response, { maxBytes, signal })`, from the package root or `@arbol-ai/maximus/body`, reads
at most `maxBytes` of an `application/json` or `+json` body and answers a Result: the parsed value, `null` for
a `204` or `205`, or the failure `HTTP_BODY_INVALID`, whose `data.reason` says why.
`retryAfterSeconds(header, Date.now())` reads a provider's `Retry-After` as seconds, at most 3600 by default.
A hint never makes repeating a write safe.

## Where values are checked

Each value is checked once, by the boundary that owns it:

| Value                                                            | Checked by                                                     |
| ---------------------------------------------------------------- | -------------------------------------------------------------- |
| An operation's input                                             | The shared execution path, on every transport, after admission |
| An operation's output and the failures it answers                | The same path, before any transport sees them                  |
| MCP's JSON-RPC envelopes                                         | The MCP SDK                                                    |
| Stored records, provider and model answers, files                | Their reader: `readSchema` or `checkSchema`                    |
| The arguments of your own RPC methods and Durable Object methods | The method that receives them                                  |

Inside a handler, values are typed and already checked:

- Do not parse an input, a value the context prepared or a Durable Object's answer of the same service
  again before returning it: the output check covers it.
- When code behind a method that checks its arguments needs the implementation, call the typed
  implementation, not the checking method.
- Never replace a check with a cast, a flag that marks a value as trusted or a cache of earlier checks.

## Contracts shared with browsers

`@arbol-ai/maximus/schemas` needs no Worker runtime. A module that a browser also imports, such as a web
app's form, takes `t`, the types, the codecs, the readers and the shared schemas from there.
