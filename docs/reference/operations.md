# Route and operation options

This page lists every field of a route's contract, of a tool's contract and of an operation definition,
with its type, its default and its effect, and then every rule `.build()` enforces, with the message of each
refusal. [Routes](../guides/routes.md) explains the fields in use.

## Route contract

`defineHandler(handler, contract?)` is a route file's default export. It takes the handler first; a contract
in its place is refused:
`defineHandler takes the handler first and its contract after it: defineHandler(async ({ input }) => …, { input, output }).`
Every field of the contract is optional.

| Field               | Type                                     | Default                                                                                                                                                                | Effect                                                                                                                                                                                                                                      |
| ------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input`             | A schema, or the fields of an object     | The empty strict object                                                                                                                                                | The schema each call's input is decoded and checked against. Fields stand for a strict object. A strict object, or a union of strict objects except on a GET; each path parameter is a required string field of it.                         |
| `output`            | A schema, or the fields of an object     | The empty strict object; the handler may return nothing                                                                                                                | The schema each answer is checked against: a strict object, a union of strict objects, or `AttachmentOutputSchema`.                                                                                                                         |
| `title`             | `string`                                 | The MCP tool's name as words (`get_note` is `Get note`), else the method and path (`GET /v1/notes/{noteId}`)                                                           | The OpenAPI `summary` and the MCP tool's title.                                                                                                                                                                                             |
| `description`       | `string`                                 | None; the OpenAPI document leaves the field out                                                                                                                        | What the route does, for people and agents: the OpenAPI `description` and the MCP tool's. A route that declares `mcp` requires one that is not blank.                                                                                       |
| `group`             | `string`                                 | The operation's name                                                                                                                                                   | The OpenAPI tag.                                                                                                                                                                                                                            |
| `operationId`       | `string`                                 | The method and path in camelCase: `PATCH /v1/notes/{noteId}` is `patchV1NotesNoteId`                                                                                   | The operation's name: the OpenAPI `operationId`, the native RPC method and the `operation` of observations. See [Names](#names).                                                                                                            |
| `scope`             | `string`, or a non-empty list of strings | `<namespace>:<resource>:read` for a read, `<namespace>:<resource>:write` otherwise, the resource being the path's first fixed segment after the version, in kebab-case | The scope a caller's token must hold. Of a list, any one admits the caller, unless `scopeMatch` is `all`. Each is `<namespace>:<resource>:<action>`, or deeper, in lowercase kebab-case segments, listed once.                              |
| `scopeMatch`        | `'any'` or `'all'`                       | `'any'`                                                                                                                                                                | Whether the scopes of a list are alternatives or all required.                                                                                                                                                                              |
| `conditionalScopes` | `string[]`                               | None                                                                                                                                                                   | Scopes the handler checks itself against `authority.scopes`, for particular resources or fields: namespaced, unique, not empty and distinct from `scope`. A call without a verified authority, an RPC call among them, answers `FORBIDDEN`. |
| `effect`            | `'read'`, `'write'` or `'delete'`        | `read` for GET, `delete` for DELETE, `write` for POST, PUT and PATCH                                                                                                   | What the route does: its default scope, and the MCP hints `readOnlyHint` and `destructiveHint`. Only a read may be a GET, and a DELETE is never a read. It never authorizes anything.                                                       |
| `failures`          | The catalog's domain codes               | Every failure of the catalog                                                                                                                                           | The domain failures the route may answer, each once, besides the standard ones: `fail` accepts only those, the OpenAPI document lists only those, and any other domain failure answers `INTERNAL_ERROR`.                                    |
| `actorKinds`        | `('user' \| 'service')[]`                | Every kind                                                                                                                                                             | The principals that may call the route; another answers `FORBIDDEN`, and MCP lists the tool to these alone. Not empty, each kind once. Required under the token scheme `oauth+bearer`.                                                      |
| `visibility`        | `'public'` or `'internal'`               | `'public'`                                                                                                                                                             | `internal` leaves the route out of the OpenAPI document and its scopes out of the OAuth discovery metadata's `scopes_supported`. The route is still served and checks its scope.                                                            |
| `http`              | [`http`](#http)                          | A JSON body and a JSON answer with `200`                                                                                                                               | The success status, a byte body, fields read from headers, an attachment. The path and method come from the file's name.                                                                                                                    |
| `mcp`               | [`mcp`](#mcp)                            | No tool                                                                                                                                                                | Also serves the route as an MCP tool.                                                                                                                                                                                                       |
| `rpc`               | [`rpc`](#rpc)                            | No RPC method                                                                                                                                                          | Also serves the route as a method of the Worker's `Service` entrypoint.                                                                                                                                                                     |
| `maxBodyBytes`      | `number`                                 | The application's `maxBodyBytes`, 32 KiB unless set                                                                                                                    | The largest request body the route accepts, in bytes: a positive integer up to 16 MiB. Not on a GET.                                                                                                                                        |
| `maxOutputBytes`    | `number`                                 | The application's `maxOutputBytes`, 256 KiB unless set                                                                                                                 | The largest output the route answers, in bytes: a positive integer up to 16 MiB. An attachment counts its `byteLength`.                                                                                                                     |

A contract kept in a `const` keeps its literal types with `satisfies HandlerOptions`.

### http

| Field           | Type                     | Default       | Effect                                                                                                                                                                                                                                                                                         |
| --------------- | ------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `successStatus` | `200`, `201` or `202`    | `200`         | The status of a successful answer.                                                                                                                                                                                                                                                             |
| `body`          | `'bytes'`                | A JSON body   | The handler reads the raw request body with `body.read()`, within `maxBodyBytes`. Not on a GET; the route is served over HTTP alone.                                                                                                                                                           |
| `headers`       | `Record<string, string>` | None          | For a byte body alone: input field to request header. Each header named with letters, digits and `-`, once whatever its case, and never `authorization`, `cookie`, `host`, `content-length` or `content-encoding`. Each field a field of the input, which is one object, and not a path field. |
| `response`      | `'attachment'`           | A JSON answer | Answers the file the handler returns. Declared exactly when `output` is `AttachmentOutputSchema`; the route is served over HTTP alone.                                                                                                                                                         |

### mcp

| Field        | Type      | Default                                                    | Effect                                                                                                                               |
| ------------ | --------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `name`       | `string`  | Required                                                   | The tool's name: a lowercase letter, then up to 63 letters, digits and `_`. Unique among the application's tools and its skill tool. |
| `idempotent` | `boolean` | `true` for GET, PUT and DELETE, `false` for POST and PATCH | Whether repeating a call has no further effect: the tool's `idempotentHint`.                                                         |
| `openWorld`  | `boolean` | `true`                                                     | Whether the tool reaches outside the service: its `openWorldHint`.                                                                   |

### rpc

`rpc: true` serves the route as a method of the Worker's `Service` entrypoint, named after the operation, to
every Worker the application's `rpc.callers` names; `rpc: { callers: ['orders'] }` serves it to those of them
it lists. A route with a byte body or an attachment is never an RPC method. [Worker
RPC](../guides/worker-rpc.md) explains the callers and their calls.

### The handler

The handler receives one object: `input`, the decoded input (`StaticDecode<typeof input>`); `fail`, which
answers a failure of the catalog; `principal`; `env`; `operation`, the operation's name; `authority`, the
verified token's surface, scopes and client, when the call has one; `background`, when the runtime provides
one; what `context.ts` prepares; and, for a byte body, `body`. It returns its output or what `fail` returns,
at once or as a promise. [Context and middleware](../guides/middleware-and-context.md) describes each.

Binding a route to its file refuses, when the Worker's module loads:

- A default export `defineHandler` did not make:
  `GET /v1/notes: a route file's default export must come from defineHandler.`
- A route without a resource and without a `scope`:
  `GET /v1/{id}: no fixed segment names its scope; declare its scope.`
- An MCP tool without a description:
  `GET /v1/notes: a route that is an MCP tool describes what it does.`
- A DELETE that only reads:
  `DELETE /v1/notes/{noteId}: a DELETE route deletes; its effect is delete or write, never read.`

## Tool contract

`defineTool(handler, contract)` is the default export of a tool only MCP serves, `mcp/tools/<name>.ts`. Its
contract has the fields of a route's, except `operationId`, `http`, `mcp` and `visibility`, and these:

| Field         | Type                              | Default                         | Effect                                               |
| ------------- | --------------------------------- | ------------------------------- | ---------------------------------------------------- |
| `description` | `string`                          | Required                        | What the tool does, for the agents that choose it.   |
| `effect`      | `'read'`, `'write'` or `'delete'` | Required                        | What the tool does: its hints and its default scope. |
| `idempotent`  | `boolean`                         | `true` for a read, else `false` | The tool's `idempotentHint`.                         |
| `openWorld`   | `boolean`                         | `true`                          | The tool's `openWorldHint`.                          |

Its file names it: `mcp/tools/summarize-tasks.ts` is the tool `summarize_tasks` and the operation
`summarizeTasks`, with the title `Summarize tasks` and the scope `<namespace>:summarize-tasks:read` for a read
or `<namespace>:summarize-tasks:write` otherwise, unless the contract states its own. Tool files are named in
kebab-case, directly in `mcp/tools/`.

## Operation definition

The builder declares an operation with `.operation(name, definition, handler)`. [Worker
composition](../guides/worker-composition.md) shows the builder in use.

| Field               | Type                                     | Required | Effect                                                                                             |
| ------------------- | ---------------------------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `scope`             | `string`, or a non-empty list of strings | Yes      | As a route's `scope`.                                                                              |
| `scopeMatch`        | `'any'` or `'all'`                       | No       | As a route's; `'any'` unless declared.                                                             |
| `conditionalScopes` | `string[]`                               | No       | As a route's.                                                                                      |
| `failures`          | `string[]`                               | No       | As a route's; every failure of the catalog unless declared.                                        |
| `title`             | `string`                                 | Yes      | The OpenAPI `summary` and the MCP tool's title.                                                    |
| `description`       | `string`                                 | Yes      | The OpenAPI `description` and the MCP tool's.                                                      |
| `group`             | `string`                                 | No       | The OpenAPI tag; the operation's name unless declared.                                             |
| `effect`            | `'read'`, `'write'` or `'delete'`        | Yes      | As a route's.                                                                                      |
| `input`             | A schema                                 | Yes      | As a route's `input`, as a schema rather than fields.                                              |
| `output`            | A schema                                 | Yes      | As a route's `output`, as a schema rather than fields.                                             |
| `maxBodyBytes`      | `number`                                 | No       | As a route's.                                                                                      |
| `maxOutputBytes`    | `number`                                 | No       | As a route's.                                                                                      |
| `actorKinds`        | `('user' \| 'service')[]`                | No       | As a route's.                                                                                      |
| `http`              | See below                                | No       | The operation's route. Without one, the operation is no route: an MCP tool or an RPC method alone. |
| `visibility`        | `'public'` or `'internal'`               | No       | As a route's.                                                                                      |
| `mcp`               | `{ name, idempotent, openWorld? }`       | No       | As a route's `mcp`, with `idempotent` required.                                                    |
| `rpc`               | `true` or `{ callers: string[] }`        | No       | As a route's.                                                                                      |

`http` holds the route itself and the options a route's `http` takes:

| Field                                          | Type                                              | Effect                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `method`                                       | `'GET'`, `'POST'`, `'PUT'`, `'PATCH'`, `'DELETE'` | Required. `GET` only for a read.                                                                                                                                                                                                                                                                |
| `path`                                         | `string`                                          | Required. `/v<n>/` and one or more segments: fixed ones of letters, digits, `_` and `-`, or whole `{name}` parameters, each named by a letter then letters, digits and `_`, used once, and not `constructor`, `prototype` or `__proto__`. Each parameter is a required string field of `input`. |
| `successStatus`, `body`, `headers`, `response` | As a route's                                      | See [http](#http).                                                                                                                                                                                                                                                                              |

The handler takes the prepared context and the decoded input, and answers a Result:

```ts
(context, input) => Promise<Result<Static<typeof output>, Failure>>;
```

`context` is the invocation and what each `.derive()` of the chain added, with `body` for a byte body: its
`read()` answers the bytes or the failure as a Result. A field no operation has is a type error, and
`.build()` refuses it.

### Names

An operation's name, a route's `operationId` or the name `.operation()` takes, is a camelCase name: a
lowercase letter, then up to 99 letters and digits. It is unique in the application, and it is none of the
names a Worker entrypoint or a promise already uses: `fetch`, `connect`, `constructor`, `then`,
`scheduled`, `queue`, `alarm`, `prototype` and `__proto__`.

## What `.build()` enforces

`.build()` checks the whole application before any request is served: a project's generated `.maximus/app.ts`
calls it when the Worker's module loads, under `vp dev`, in tests and in the deployed Worker. Each refusal is
a `TypeError` whose message names the rule. A refusal about one operation names the operation, and one about
a route names its path or the routes in conflict. The rules run in this order, so an application that breaks
several always meets the same refusal first.

### The application

| Rule                                                                                       | Refusal                                                                                                                           |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| The scope namespace is a lowercase letter, then 1 to 63 lowercase letters, digits and `-`. | `A scope namespace is required.`                                                                                                  |
| The name follows the same rule.                                                            | `An application name is a lowercase kebab-case word of 2 to 64 characters.`                                                       |
| Each operation's `failures` lists domain codes of the catalog, each once.                  | `Operation "listNotes": failures lists each domain failure code of the error catalog once; standard failures are always allowed.` |

### Each operation

Each operation in turn, in the order they were declared:

| Rule                                                                                                            | Refusal                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every field is an operation field.                                                                              | `Operation "listNotes": "visiblity" is not an operation field.`                                                                                                                                                |
| `scopeMatch` is `any` or `all`.                                                                                 | `Operation "listNotes": scopeMatch must be any or all.`                                                                                                                                                        |
| An input with codecs is wrapped in `inputSchema()`.                                                             | `Operation "listNotes": its input uses codecs (normalize, transform, inspect, refine, pipe or stripObject) that run only inside inputSchema(); wrap the input in inputSchema().`                               |
| `actorKinds` names `user`, `service` or both, each once.                                                        | `Operation "listNotes": actorKinds must explicitly name eligible users or services.`                                                                                                                           |
| The name follows the rules of [Names](#names).                                                                  | `Operation "listNotes": use a camelCase name of up to 100 characters that is not a reserved Worker method. Use safe operation names, namespaced scopes and strict object schemas.`                             |
| Every scope belongs to the namespace, and none is listed twice.                                                 | `Operation "listNotes": every scope is "notes:<resource>:<action>", listed once. Use safe operation names, namespaced scopes and strict object schemas.`                                                       |
| The input and output are strict objects or unions of them; a GET's input is one strict object.                  | `Operation "listNotes": input and output are strict objects or unions of strict objects; a GET input is one strict object (its query). Use safe operation names, namespaced scopes and strict object schemas.` |
| A record whose keys follow a pattern sets `additionalProperties: false`.                                        | `Operation "listNotes": a record whose keys follow a pattern takes additionalProperties: false, t.Record(key, value, { additionalProperties: false }), or a key outside the pattern passes unchecked.`         |
| Under the token scheme `oauth+bearer`, the operation declares `actorKinds`.                                     | `Operation "listNotes": dual authentication requires explicit actor eligibility.`                                                                                                                              |
| `http.body` is `bytes` and `http.response` is `attachment`, when declared.                                      | `Operation "uploadDocument": unsupported HTTP binary contract.`                                                                                                                                                |
| A byte body or an attachment is served over HTTP alone.                                                         | `Operation "uploadDocument": byte bodies and attachments are HTTP-only.`                                                                                                                                       |
| `http.response: 'attachment'` goes with `AttachmentOutputSchema`, and a byte body with a method other than GET. | `Operation "downloadDocument": declare matching attachment output and non-GET byte bodies.`                                                                                                                    |
| `maxOutputBytes` is a positive integer up to 16 MiB.                                                            | `Operation "listNotes": invalid output byte limit.`                                                                                                                                                            |
| `http.successStatus` is `200`, `201` or `202`.                                                                  | `Operation "createNote": invalid success status; use 200, 201 or 202.`                                                                                                                                         |
| `http.headers` follows the rules of [http](#http).                                                              | `Operation "uploadDocument": byte operation headers must name unique, non-authority metadata fields.`                                                                                                          |
| `maxBodyBytes` is a positive integer up to 16 MiB, on an operation that is not a GET.                           | `Operation "listNotes": an operation body limit is a positive integer up to 16 MiB, on a non-GET route.`                                                                                                       |
| The path is versioned.                                                                                          | `Operations require a versioned path, such as /v1/tasks: /notes`                                                                                                                                               |
| Its parameters have safe names, each used once.                                                                 | `Path parameter names must be unique and safe: /v1/notes/{noteId}/{noteId}`                                                                                                                                    |
| Its segments are fixed names or whole parameters.                                                               | `Use fixed routes or complete {parameter} segments; empty and malformed segments are forbidden: /v1/notes/`                                                                                                    |
| Each parameter is a required string field of the input, in every member of a union.                             | `Path parameter "noteId" must be a required string input field.`                                                                                                                                               |
| Each method and path has one operation, and a GET is a read.                                                    | `Operation "archiveNote": use unique versioned routes; mutations cannot use GET.`                                                                                                                              |
| `conditionalScopes` is not empty, lists each scope once, in the namespace, and none of the admission scopes.    | `Operation "listNotes": conditional scopes require unique namespaced declarations distinct from the admission scope.`                                                                                          |
| An MCP tool's name is safe and unique.                                                                          | `Operation "listNotes": MCP tools require unique safe names.`                                                                                                                                                  |
| `rpc.callers` names only Workers of the application's `rpc.callers`.                                            | `Operation "listNotes": RPC callers must be allowed by the application.`                                                                                                                                       |

### Routes and schemas

| Rule                                                                                                     | Refusal                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every method is one of the five.                                                                         | `Operation routes require a supported HTTP method: HEAD /v1/notes`                                                                                                                                                                       |
| No two templates of one method match the same paths, as `/v1/notes/{noteId}` and `/v1/notes/{id}` would. | `Ambiguous operation path templates: GET /v1/notes/{noteId} and GET /v1/notes/{id}`, or, for templates that overlap on some paths, `Ambiguous overlapping operation path templates: GET /v1/{folder}/notes and GET /v1/archive/{noteId}` |
| A schema reference names exactly one definition among the operations' and the catalog's schemas.         | `Schema reference "Note" does not name exactly one definition.`                                                                                                                                                                          |

### MCP, limits, origin and tokens

| Rule                                                                                                                                                               | Refusal                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each guide's name is a lowercase letter, then up to 63 lowercase letters, digits and `-`, and unique.                                                              | `Guides require unique safe names.`                                                                                                                                          |
| Each skill has a unique name of at most 64 lowercase letters and digits joined by single `-`, a one-line description of at most 1024 characters, and instructions. | `Skills require unique Agent Skills names, a one-line description and instructions.`                                                                                         |
| No guide or skill shares a name with another, or takes `openapi-json` or `openapi-yaml`.                                                                           | `MCP resource name onboarding is taken: guides and skills need names of their own, and openapi-json and openapi-yaml name the OpenAPI document.`                             |
| A skill tool comes with skills and has a safe name no operation's tool takes.                                                                                      | `A skill tool requires skills and a safe name no operation uses.`                                                                                                            |
| The application's `maxBodyBytes` is a positive integer up to 16 MiB.                                                                                               | `The application body limit is a positive integer up to 16 MiB.`                                                                                                             |
| The application's `maxOutputBytes` is a positive integer up to 16 MiB.                                                                                             | `The application output limit is a positive integer up to 16 MiB.`                                                                                                           |
| The origin is HTTPS.                                                                                                                                               | `Application origin must use HTTPS.`                                                                                                                                         |
| `telemetry.enabled` is a boolean or a function, `telemetry.observers` a list of objects whose callbacks are functions, and `telemetry.traceId` a function.         | `Telemetry takes enabled as true, false or a function of env, observers as a list of objects whose execution, admission and error are functions, and traceId as a function.` |
| `tokens.development` names its binding, and a valid organization id when it names one.                                                                             | `tokens.development names the binding of its token and a valid organization id.`                                                                                             |
| `tokens.algorithms` lists asymmetric JWS algorithms.                                                                                                               | `tokens.algorithms lists one or more asymmetric JWS algorithms.`                                                                                                             |
| `tokens.claims` names each claim by a non-empty string.                                                                                                            | `tokens.claims names each claim by a non-empty string (permissions may be false), and machineSubject is {client}@clients or {client}.`                                       |
| OAuth tokens have an issuer.                                                                                                                                       | `tokens.issuer is required to verify or document OAuth access tokens.`                                                                                                       |
| The issuer and its endpoints are HTTPS.                                                                                                                            | `tokens.issuer, jwksUri, authorizationEndpoint and tokenEndpoint must be absolute HTTPS URLs, the last three resolved against the issuer.`                                   |
| `tokens.audience` is a non-empty string, or a list of distinct ones.                                                                                               | `tokens.audience must be a non-empty string or a non-empty list of distinct non-empty strings.`                                                                              |
| `tokens.resources` comes with `tokens.resourceMetadataUrl`.                                                                                                        | `tokens.resources requires tokens.resourceMetadataUrl: name the metadata a 401 challenge points at.`                                                                         |

Under the application's own `bearer` scheme, the token rules about OAuth (algorithms, claims, the issuer and
its endpoints) do not apply. [Configuration](configuration.md) describes the token options.

### While the builder is used

The builder refuses some mistakes as soon as they are made:

- `.derive()` after `.operation()` on the same chain: `Derive context before declaring operations.`
- `.mount()` of a module built from another `maximus()` call:
  `Resource groups must derive from the same application.`
- Two operations of one name: `Duplicate operation: listNotes`
