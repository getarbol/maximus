# Schemas and validation

Maximus schemas are [TypeBox](https://github.com/sinclairzx81/typebox) schemas. This guide covers
writing them, the codecs that normalize and refine input, query strings, reading untrusted data, and
the rules about where validation happens.

## Writing schemas

```ts
import { t, UuidSchema } from '@arbol-ai/maximus';
import type { Static } from '@arbol-ai/maximus';

export const TaskSchema = t.Object(
  {
    taskId: UuidSchema,
    title: t.String({ minLength: 1, maxLength: 200 }),
    status: t.Union([t.Literal('open'), t.Literal('done')]),
    completedAt: t.Union([t.String({ format: 'date-time' }), t.Null()]),
  },
  { additionalProperties: false }
);
export type Task = Static<typeof TaskSchema>;
```

- Operation inputs and outputs are strict objects, or unions whose every member is a strict object,
  discriminated by a field. A GET input is one strict object. Construction refuses anything else.
- Ids are strings. Name the organization `organizationId` and correlation ids `requestId`; do not
  invent aliases such as `tenantId` or `orgId`.
- Present every field explicitly; use `t.Null()` in a union for "no value" rather than leaving a
  field out of an output.
- Use the [shared schemas](#shared-schemas) for organization ids, UUIDs, emails, phone numbers and
  the other values every service publishes, rather than a local copy.

## Shared schemas

Values and objects that every service publishes alike carry an `$id`, so the OpenAPI document holds
each once as a component of that name and every SDK generated from those documents has one type for
it. Use them as they are; spread one to give a field its own description
(`{ ...EmailAddressSchema, description: 'Where the receipt goes.' }`).

| Export                                  | Component           | Shape                                                                                                                         |
| --------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `OrganizationIdSchema`                  | `OrganizationId`    | string `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`: the ids identity providers issue (`org_…`, UUIDs, slugs)                          |
| `UuidSchema`                            | `Uuid`              | an RFC 9562 UUID, lower case                                                                                                  |
| `EmailAddressSchema`                    | `EmailAddress`      | string, format `email`, at most 254 characters                                                                                |
| `PhoneNumberSchema`                     | `PhoneNumber`       | E.164, `^\+[1-9][0-9]{1,14}$`                                                                                                 |
| `HttpsUrlSchema`                        | `HttpsUrl`          | string, format `uri`, `^https://`, at most 2048 characters                                                                    |
| `HexColorSchema`                        | `HexColor`          | `#rrggbb`                                                                                                                     |
| `DeletedObjectSchema`                   | `DeletedObject`     | `{ id: string, deleted: true }`: what a `delete` answers                                                                      |
| `SignedUrlSchema`                       | `SignedUrl`         | `{ url: HttpsUrl, expiresAt: date-time }`: a link that grants access by itself until it expires                               |
| `NamedReferenceSchema`                  | `NamedReference`    | `{ id: string, name: string }`                                                                                                |
| `PostalAddressSchema`                   | `PostalAddress`     | FHIR-shaped `{ line?: string[] (≤ 4), city?, state?, postalCode?, countryCode?: ISO 3166-1 alpha-2, use?: 'home' \| 'work' }` |
| `PageInfoSchema`, `Page(item, { $id })` | `PageInfo`, `<$id>` | See [Lists](#lists)                                                                                                           |
| `FailureSchema` (`/errors`)             | `Failure`           | `{ code, message, retryable, data }`, the base every failure narrows                                                          |

`EmptyInputSchema` (`{}`, strict) stays unnamed. Every object is strict. Dates and times stay plain
`date-time` and `date` strings. Domain records (people, patients, identity documents, locations)
belong to the service that owns them; name your own entities with an `$id` of their own.

A name is public, so it names exactly one shape: two different schemas under one `$id` become two
components, the second suffixed `_2`. Only the OpenAPI document uses the names. MCP tool schemas write
each named schema in place, as they did before it was named.

Formats `date`, `time`, `date-time`, `email`, `uuid` and `uri` use maintained RFC validators, without
generating code at runtime. `date-time` requires a time zone. Values longer than 8192 characters fail
any format.

## Encoded and decoded types

An input schema can change a value on its way in, for example by trimming text or turning a query
string into a number. Two types follow:

- the **encoded** type, `Static<typeof Input>`, is what callers send. OpenAPI and the typed client
  use it;
- the **decoded** type, `StaticDecode<typeof Input>`, is what your handler receives.

For a schema without codecs they are the same. A field declared with `transformSchema`,
`normalizeSchema` or `pipeSchema` is encoded as its source schema: callers send what the source
checks, and the handler receives what the codec returns. `checkSchema` and `readSchema` answer the
decoded type.

## Input codecs

Owner semantics live beside the schema, in `@arbol-ai/maximus/schemas`, and are compiled into the
one validation boundary by `inputSchema`:

```ts
import { defaultSchema, inputSchema, normalizeSchema, refineSchema, t } from '@arbol-ai/maximus/schemas';

const SearchSchema = t.Object(
  {
    query: normalizeSchema(t.String({ minLength: 1, maxLength: 100 }), (value) => value.trim()),
    limit: defaultSchema(t.Integer({ minimum: 1, maximum: 50 }), 20),
    from: t.String({ format: 'date' }),
    to: t.String({ format: 'date' }),
  },
  { additionalProperties: false }
);

export const SearchInputSchema = inputSchema(
  refineSchema(SearchSchema, (value) => value.from <= value.to, {
    message: 'The range must not end before it starts.',
    path: ['to'],
  })
);
```

**Wrap an operation input in `inputSchema()` whenever it uses a codec.** A plain decode would skip
normalizers, transforms, refinements and stripping and apply only the TypeBox checks and defaults,
so `.build()` refuses an operation input that uses a codec outside `inputSchema()`.

| Helper                                                                                                       | Effect                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inputSchema(schema)`                                                                                        | Compiles the codecs below into one decoding schema. Defaulted fields become optional on the wire.                                                                                                     |
| `inputSchema(schema, wire)`                                                                                  | Declares a different wire schema, decoded and then checked against `schema`. See [Query strings](#query-strings).                                                                                     |
| `inputSchema(schema, { stripUnknown: true })`                                                                | Drops unknown keys of objects declared with `stripObject`, instead of refusing them. For readers of stored or provider data; an operation input stays strict, and `.build()` refuses this form there. |
| `defaultSchema(schema, value)`                                                                               | A default applied before the handler.                                                                                                                                                                 |
| `normalizeSchema(schema, fn)`                                                                                | Runs `fn` on the raw value, then applies the schema's length, pattern and format checks. Consecutive normalizers all run before those checks.                                                         |
| `transformSchema(schema, fn)`                                                                                | Validates the source value, then converts it with `fn`.                                                                                                                                               |
| `refineSchema(schema, predicate, detail?)`                                                                   | A semantic rule. `detail` is a message or `{ message, path }`.                                                                                                                                        |
| `inspectSchema(schema, (value, { addIssue }) => …)`                                                          | Like `refineSchema`, reporting any number of issues.                                                                                                                                                  |
| `pipeSchema(source, target)`                                                                                 | Validates and decodes `source`, then checks and decodes the result against `target`.                                                                                                                  |
| `stripObject(properties)`, `strictObject(schema)`, `looseObject(schema)`, `extendObject(object, properties)` | Object shapes with explicit unknown-key behavior.                                                                                                                                                     |
| `literalUnion(['a', 'b'])`                                                                                   | A union of literals.                                                                                                                                                                                  |
| `urlSchema({ protocol, hostname?, maxLength? })`                                                             | A URI whose protocol (and optionally hostname) matches the given expressions.                                                                                                                         |

Callbacks run in declaration order. A refinement's message travels to the caller in
`INVALID_INPUT` issues, so it must never contain the input's values.

Outputs are checked, never decoded: a response must already be canonical. Keep the canonical schema
for outputs and compile inputs from it, so output validation never repairs malformed data.

## Query strings

A GET input arrives in the query string. A field declared as an integer, number, boolean or list of
strings is read as one (`?limit=2&active=true&tags=a,b`), the way generated clients write it. For any
other conversion, declare the wire schema with a decoding transform and the canonical schema
separately; a wire field declared as a string stays a string:

```ts
import { inputSchema, t } from '@arbol-ai/maximus/schemas';

const ListTasksQuery = t.Object(
  {
    limit: t.Optional(
      t
        .Transform(t.String({ pattern: '^[1-9][0-9]{0,2}$' }))
        .Decode((value) => Number(value))
        .Encode((value) => String(value))
    ),
    status: t.Optional(t.Union([t.Literal('open'), t.Literal('done')])),
  },
  { additionalProperties: false }
);
const ListTasksInput = t.Object(
  {
    limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
    status: t.Optional(t.Union([t.Literal('open'), t.Literal('done')])),
  },
  { additionalProperties: false }
);

// input: inputSchema(ListTasksInput, ListTasksQuery)
```

The decimal pattern belongs to the wire schema; the numeric bounds to the canonical one. OpenAPI
documents the wire schema, the client sends strings, and the handler receives a number.

## Lists

Every list uses one contract: bidirectional keyset pagination with an opaque cursor, and no page
number, offset or implicit total. Spread `PageQueryFields` into the list's input beside its own
filters, and name its output with `Page`:

```ts
import { Page, PageQueryFields, inputSchema, t } from '@arbol-ai/maximus/schemas';
import type { PageQuery } from '@arbol-ai/maximus/schemas';

export const ListTasksInputSchema = inputSchema(
  t.Object(
    { ...PageQueryFields, status: t.Optional(t.Union([t.Literal('open'), t.Literal('done')])) },
    { additionalProperties: false }
  )
);
export const TaskPageSchema = Page(TaskSchema, { $id: 'TaskPage' });

// A repository takes the PageQuery and answers the generic type Page<Task>.
export declare function listTasks(organizationId: string, query: PageQuery): Promise<Page<Task>>;
```

The input takes `cursor` (optional, opaque), `direction` (`forward` or `backward`, default
`forward`) and `limit` (an integer from 1 to 100, default 25); `inputSchema` applies the defaults
and lists them as optional, so the handler always receives `direction` and `limit`. A list whose items
are costly lowers its maximum with `pageLimit`:
`{ ...PageQueryFields, limit: pageLimit({ maximum: 20 }) }` (the default becomes the smaller of 25 and
the maximum, unless you pass `default`). The output is
`{ object: 'list', data: Item[], pageInfo }`, where `pageInfo` is `PageInfoSchema`:
`{ hasNextPage, hasPreviousPage, nextCursor, previousCursor }`, the cursors a string or `null`. The
exact schemas are in the [wire formats reference](../reference/wire-formats.md#lists).

`PageInfo` and each page are named schemas, so the OpenAPI document carries each once as a
component (`#/components/schemas/TaskPage`) and every SDK generated from it shares their types.
That makes the name public:

- give each list its own PascalCase name, conventionally the item's name and `Page`. `Page`
  refuses any other name;
- use a name for one shape only. Two different schemas under one `$id` become two components, the
  second suffixed `_2`, and SDKs see two types.

Every operation that returns many items should answer a page, so clients page every list the same
way.

## Reading untrusted data

Data that is not an operation's input still crosses a trust boundary: a stored record, a provider
response, a model's answer, a file an operator wrote. Read it through its schema:

```ts
import { checkSchema, readSchema } from '@arbol-ai/maximus/schemas';

const stored = await env.TASKS.get(key);
const task = stored === null ? null : readSchema(TaskSchema, JSON.parse(stored)); // throws if invalid

const answer = checkSchema(ProviderAnswerSchema, body);
if (!answer.success) {
  return err(errors.upstreamUnavailable.create()); // answer.error.issues: [{ code, message, path }]
}
```

`checkSchema` returns `{ success: true, data }` or `{ success: false, error }`, where `error` is a
`SchemaValidationError` listing every issue with its path. `readSchema` returns the data or throws
that error. Both apply the schema's owner semantics: defaults, normalizers before checks, and unknown
keys of `stripObject` objects dropped. Neither coerces types.

Lower-level helpers:

| Helper                        | Use                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `decodeInput(schema, value)`  | The operation boundary as a function: a `Result` whose failure is `INVALID_INPUT` with issues.         |
| `decodeSchema(schema, value)` | The same decoding, throwing on refusal.                                                                |
| `parseInput(schema, value)`   | Check only, no defaults or codecs: `{ ok: true, value }` or an `INVALID_INPUT` failure without issues. |
| `parseSchema(schema, value)`  | Check only, returning the value or throwing.                                                           |

All of them accept only plain JSON trees: no class instances, cycles, non-finite numbers or nesting
deeper than 100 levels.

For provider calls, read bodies with a byte limit before parsing them. `readJsonResponse(response,
{ maxBytes, signal })` (from `@arbol-ai/maximus` or `@arbol-ai/maximus/body`) answers a `Result` and
accepts `application/json` and `+json` media types; `retryAfterSeconds(header, Date.now())` reads a
`Retry-After` hint. A hint never makes repeating a write safe.

In a Worker, `fetch` accepts only `redirect: 'follow'` and `redirect: 'manual'`: `redirect: 'error'`
throws a `TypeError` before any request leaves, so the call never reaches its provider, and a `catch`
that reports an outage hides it. Send a credential with `redirect: 'manual'` and refuse a `3xx`
response, so the key never follows a redirect and the call still runs:

```ts
const response = await fetch(url, {
  headers: { authorization: `Bearer ${key}` },
  redirect: 'manual',
  signal,
});
if (response.status >= 300 && response.status < 400) {
  await response.body?.cancel();
  return err(errors.upstreamUnavailable.create());
}
```

## Validation ownership

Each value is checked exactly once, by the boundary that owns it:

| Value                                                            | Checked by                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------- |
| Operation input                                                  | The shared execution path, on every transport, after admission. |
| Operation output and returned failures                           | The same path, before any transport sees them.                  |
| MCP JSON-RPC envelopes                                           | The MCP SDK.                                                    |
| Stored records, provider and model responses, operator files     | Their own reader: `checkSchema` or `readSchema`.                |
| The arguments of your own RPC methods and Durable Object methods | The method that receives them.                                  |

Inside a handler, values are typed and already checked:

- Do not parse an input, a derived value or a same-owner Durable Object result again before
  returning it; the output check covers it.
- When code behind a validating method needs the implementation, call the typed implementation
  rather than the public method.
- Never replace a check with a cast, a trust flag, a no-op validator or a cache of earlier results.

## Contracts shared with browsers

`@arbol-ai/maximus/schemas` needs no Worker runtime. A contract module that a browser also imports
(a dashboard reading an API's limits, a widget's settings) takes `t`, `Static`, `StaticDecode`, the
codecs, the readers and the shared schemas from there. The package root works in a browser too, but
brings the whole framework.
