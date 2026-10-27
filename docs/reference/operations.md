# Operation reference

`builder.operation(name, definition, handler)` declares one operation. This page lists every field of
`definition`. Construction refuses an operation that breaks a rule with a `TypeError` stating the
rule, usually with the operation's name.

## Name

`^[a-z][a-zA-Z0-9]*$`, unique in the application, and not `fetch`, `connect`, `constructor`, `then`,
`scheduled`, `queue`, `alarm`, `__proto__` or `prototype`. The name is the OpenAPI `operationId`
and the native RPC method.

## Handler

```ts
(context, input) => Promise<Result<Static<typeof output>, Failure>>;
```

`input` is `StaticDecode<typeof input>`. `context` is the invocation plus everything the chain's
`.derive()` calls added; byte-upload operations also receive `body`. See
[Middleware and context](../guides/middleware-and-context.md).

## An example

Every operation declares its scope and each way it is reached:

```ts
base.operation(
  'listMembers',
  {
    title: 'List the team',
    description: "The organization's members with their roles.",
    scope: 'team:members:read',
    effect: 'read',
    input: EmptyInputSchema,
    output: TeamSchema,
    http: { method: 'GET', path: '/v1/members' },
    mcp: { name: 'list_members', idempotent: true },
    actorKinds: ['user'],
    failures: ['DIRECTORY_UNAVAILABLE'], // documented and enforced; standard failures always allowed
  },
  async ({ principal }) => ok(await team(principal.organizationId))
);
```

A field no operation has, such as a misspelled one, is a type error rather than silently ignored.

## Core fields

| Field               | Type                              | Required | Rule                                                                                                                                                                                                                                      |
| ------------------- | --------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`             | `string`                          | Yes      | OpenAPI `summary`, MCP tool title.                                                                                                                                                                                                        |
| `description`       | `string`                          | Yes      | OpenAPI `description`, MCP tool description.                                                                                                                                                                                              |
| `scope`             | `string \| [string, ...string[]]` | Yes      | Each `<namespace>:<resource>:<action>` with this application's namespace, listed once. A list admits a caller holding any one of them, unless `scopeMatch` is `all`.                                                                      |
| `scopeMatch`        | `'any' \| 'all'`                  | No       | How a list of scopes is matched. Default `any`.                                                                                                                                                                                           |
| `conditionalScopes` | `string[]`                        | No       | Namespaced scopes the handler checks itself, distinct from `scope`, unique, non-empty. Calls without token authority are refused.                                                                                                         |
| `effect`            | `'read' \| 'write' \| 'delete'`   | Yes      | Only `read` may use `GET`.                                                                                                                                                                                                                |
| `input`             | `TSchema`                         | Yes      | A strict object, or a union of strict objects (not for `GET`).                                                                                                                                                                            |
| `output`            | `TSchema`                         | Yes      | A strict object, a union of strict objects, or `AttachmentOutputSchema`.                                                                                                                                                                  |
| `group`             | `string`                          | No       | OpenAPI tag. Default: the operation name.                                                                                                                                                                                                 |
| `failures`          | `string[]`                        | No       | The domain failure codes the operation may answer, each once. Its documents then list only these and the standard failures, and any other domain failure it returns becomes `INTERNAL_ERROR` and is reported. Omitted: the whole catalog. |
| `maxBodyBytes`      | `number`                          | No       | Request body limit, 1 to 16 MiB. Not on `GET`. Default: the application's.                                                                                                                                                                |
| `maxOutputBytes`    | `number`                          | No       | Output limit, 1 to 16 MiB. Default: the application's, else 256 KiB.                                                                                                                                                                      |
| `actorKinds`        | `('user' \| 'service')[]`         | No       | Who may execute it. Non-empty, unique. With `tokens.scheme` `oauth+bearer`, the OpenAPI document needs it on every operation to choose its security scheme.                                                                               |
| `visibility`        | `'public' \| 'internal'`          | No       | `internal` hides the operation from OpenAPI and `scopes_supported`; MCP lists it only to holders of its scope. The origin still serves it, decided by its scopes. Default `public`.                                                       |

## http

| Field           | Type                                              | Rule                                                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `method`        | `'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE'` | `GET` only for reads.                                                                                                                                                                                                                     |
| `path`          | `string`                                          | `/v<n>/…`: segments of `[A-Za-z0-9_-]` or whole-segment `{parameter}` names (`^[a-zA-Z][a-zA-Z0-9_]*$`, not `constructor`, `prototype` or `__proto__`, unique). Each parameter is a required string input field. `METHOD path` is unique. |
| `successStatus` | `200 \| 201 \| 202`                               | Default `200`.                                                                                                                                                                                                                            |
| `body`          | `'bytes'`                                         | The handler reads the raw body through `context.body`. Not on `GET`; HTTP-only.                                                                                                                                                           |
| `headers`       | `Record<string, string>`                          | For byte uploads only: input field → request header. Header names `^[A-Za-z0-9-]+$`, unique, not `authorization`, `cookie`, `host`, `content-length` or `content-encoding`; fields exist in the input and are not path fields.            |
| `response`      | `'attachment'`                                    | Required exactly when `output` is `AttachmentOutputSchema`. HTTP-only.                                                                                                                                                                    |

## mcp

| Field        | Type      | Rule                                                                                                                                                        |
| ------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`       | `string`  | `^[a-z][A-Za-z0-9_]{0,63}$`, unique, not the skill tool's name. Served by the MCP transport (`transports: [mcp()]`); the application's `mcp` is not needed. |
| `idempotent` | `boolean` | Required. Becomes `idempotentHint`.                                                                                                                         |
| `openWorld`  | `boolean` | Becomes `openWorldHint`. Default `true`.                                                                                                                    |

## rpc

`true` admits every caller in the application's `rpc.callers`; `{ callers: string[] }` admits a
subset of them. Not allowed with byte bodies or attachments.
