# Upgrading to 9.0

This guide moves an 8.x service to Maximus 9.0, which runs on TypeBox 1.x (the package `typebox`, 1.4.5)
instead of `@sinclair/typebox` 0.34. Routes, transports, the response envelope, failures, MCP and RPC do not
change, and neither do the OpenAPI documents, apart from the order of the keys inside a schema and the key
pattern of `t.Record(t.String(), …)`. What callers see changes in one place: the wording of the issues an
`INVALID_INPUT` failure carries.

Work on a branch, and save the OpenAPI document your service serves today before you start. Compare it with
the one 9.0 serves as parsed JSON, since the key order differs: any other difference is a change to look at.

## Update the package

```sh
bun add @arbol-ai/maximus@^9
```

Remove `@sinclair/typebox` from the service's dependencies and import `t`, `Static` and `TSchema` from
`@arbol-ai/maximus` or `@arbol-ai/maximus/schemas`. A schema built with 0.34's `Type` is not a TypeBox 1.x
type, and Maximus does not read it. A service that imports `typebox` itself, to register a format for
instance, depends on exactly the version Maximus uses, `typebox@1.4.5`, so the two share one registry.

## Annotate a schema, never spread it

TypeBox 1.x keeps what makes a schema optional (`'~optional'`), a codec (`'~codec'`), a refinement
(`'~refine'`) or a TypeBox type at all (`'~kind'`) in properties that are not enumerable, and a spread copies
only the enumerable ones. In 8.x, `{ ...schema, description }` kept them; in 9.0 it drops them:

- `{ ...t.Optional(t.String()), description }` is a required field;
- a spread `t.Codec(…)` decodes nothing, and a spread `t.Refine(…)` refines nothing;
- a spread `AttachmentOutputSchema` is no longer an attachment;
- a spread schema given whole as an operation's `input` or `output` is read as a record of fields.

`annotate(schema, options)`, from the root and `/schemas`, copies a schema with everything TypeBox keeps on
it and adds the options. Its type is the schema's and the options':

```ts
import { annotate, EmailAddressSchema, t } from '@arbol-ai/maximus';

const ReceiptSchema = t.Object(
  {
    sendTo: annotate(EmailAddressSchema, { description: 'Where the receipt goes.' }),
    note: annotate(t.Optional(t.String({ maxLength: 500 })), { description: 'A note for the patient.' }),
  },
  { additionalProperties: false }
);
```

Spreading a record of fields is still safe, because it copies each schema whole:
`t.Object({ ...PageQueryFields, done: t.Optional(t.Boolean()) }, { additionalProperties: false })`. To find
the spreads to change, search for object spreads whose source is a schema, such as
`rg -n '\.\.\.[A-Za-z]+Schema\b|\.\.\.t\.' src`, and read each one.

## Builders TypeBox 1.x renamed or removed

| 0.34                                                                               | 1.x                                                                                                                   |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `t.Transform(type).Decode(decode).Encode(encode)`                                  | `t.Codec(type).Decode(decode).Encode(encode)`                                                                         |
| `t.Recursive((Self) => t.Object({ children: t.Array(Self) }), { $id: 'Node' })`    | `t.Cyclic({ Node: t.Object({ children: t.Array(t.Ref('Node')) }) }, 'Node')`                                          |
| `t.Composite([A, B])`                                                              | `t.Object({ ...A.properties, ...B.properties }, { additionalProperties: false })`, or `extendObject(A, B.properties)` |
| `t.Ref(NoteSchema)`                                                                | `t.Ref('Note')`: a reference takes the name alone                                                                     |
| `t.Date`, `t.Uint8Array`, `t.RegExp`, `t.Promise`, `t.Iterator`, `t.AsyncIterator` | Removed, as are `t.Awaited`, `t.Const`, `t.Not`, `t.ReadonlyOptional` and `t.Argument`: no JSON contract uses them    |

- `t.Refine(type, check, error?)` is new: TypeBox's own refinement, whose `error` is a function of the value
  that answers the message. Like a `refineSchema` message, it reaches the caller and never holds the value.
- `t.Union` types its members as a tuple: `t.Union(values.map((value) => t.Literal(value)))` has the static
  type `never`. Use `literalUnion(values)`, which types the values of a list of any length, and `annotate` it
  for a description: `annotate(literalUnion(PRODUCTS.map(({ id }) => id)), { description: '…' })`.
- A schema's type names its kind and structure only: `TSchema` is an empty interface, and a `TObject` has
  `properties` and `required` but no `additionalProperties`, `$id` or `description`, as a `TString` has no
  `pattern`. Reading such a keyword no longer compiles: read it through `SchemaKeywords`, from the root and
  `/schemas`, as `(UuidSchema as SchemaKeywords).pattern`.

## Formats

- `date`, `time`, `date-time`, `email`, `uuid` and `uri` are checked by the same RFC validators as in 8.x,
  and admit exactly the same values.
- The other formats TypeBox knows (`hostname`, `ipv4`, `ipv6`, `url`, `uri-reference`, `duration`, …) are
  checked by TypeBox's own validators, where 8.x refused every value of them.
- TypeBox admits any text for a format it does not know, where 0.34 refused every value. So that a misspelt
  format cannot check nothing, `.build()` refuses a contract that names one:
  `Operation "createNote": no validator checks the format "datetime", so any text would pass; use a format TypeBox checks, or a pattern.`
  A schema read outside a contract, with `checkSchema` or `readSchema`, is not checked this way.
- A value longer than 8192 characters still fails every format.

## INVALID_INPUT issues

The failure keeps its shape: at most ten `{ path, message }` issues, each path a JSON Pointer from the
input's root, never a value. The messages are TypeBox 1.x's:

| 8.x                                                      | 9.0                                       |
| -------------------------------------------------------- | ----------------------------------------- |
| `Expected required property` and the field's own message | `must be present`, one issue              |
| `Unexpected property`                                    | `must not be present`                     |
| `Expected string` (`number`, `integer`, `boolean`, …)    | `must be string` (`number`, `integer`, …) |
| `Expected string length greater or equal to 1`           | `must not have fewer than 1 characters`   |
| `Expected string length less or equal to 64`             | `must not have more than 64 characters`   |
| `Expected string to match '^[0-9]+$'`                    | `must match pattern "^[0-9]+$"`           |
| `Expected string to match 'uri' format`                  | `must match format "uri"`                 |
| `Expected integer to be less or equal to 100`            | `must be <= 100`                          |
| `Expected array length to be less or equal to 3`         | `must not have more than 3 items`         |
| `Expected union value`                                   | `must match a schema in anyOf`            |

A missing required field is one issue at its own path, where 8.x answered two. The messages of a
`refineSchema`, an `inspectSchema` or a codec that throws `SchemaValidationError` are unchanged. Update the
tests that assert TypeBox's messages; issues that only check paths keep passing.

## Codecs, types and validation

- `inputSchema()` answers a TypeBox codec, `TCodec`, where 8.x answered a `TTransform`. What callers send is
  still `SchemaInput<typeof schema>`, and what the handler receives `StaticDecode<typeof schema>`, now
  TypeBox's own. The owner codecs (`normalizeSchema`, `transformSchema`, `refineSchema`, `inspectSchema`,
  `pipeSchema`, `stripObject`, …) keep their signatures and behavior, and an issue found inside a nested codec,
  refinement or pipe keeps its full path.
- TypeBox's own `t.Codec` and `t.Refine` run in an input, inside `inputSchema()` or without it.
- An operation's `input` or `output` is told from a record of fields by the kind TypeBox marks its types with,
  as `KindGuard` did in 8.x.
- Validation stays interpreted: Maximus turns TypeBox's acceleration off, so nothing is compiled at runtime,
  and TypeBox builds at most ten errors per check.

## Check the service

1. Run the type check: it finds removed builders, keywords read from a `TSchema` and unions typed `never`.
2. Replace every spread of a schema with `annotate`.
3. Update the tests that assert TypeBox's messages.
4. Compare the OpenAPI document with the one you saved, as parsed JSON.
