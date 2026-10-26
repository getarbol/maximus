# MCP

`@arbol-ai/maximus/mcp` serves your operations as [Model Context Protocol](https://modelcontextprotocol.io)
tools over Streamable HTTP, using the official MCP SDK. The tools are the same operations your HTTP
API runs: same schemas, scopes, handlers and failures.

## Add the transport

1. Configure MCP on the application. `mcp: {}` is enough; the fields are optional.

   ```ts
   export const base = maximus<Env>({
     // ...
     mcp: {
       instructions: "Tasks of the caller's organization. List tasks before changing them.",
     },
   });
   ```

2. Name a tool on each operation that should be one:

   ```ts
   base.operation(
     'listTasks',
     {
       scope: ['tasks:tasks:read', 'tasks:tasks:write'],
       effect: 'read',
       title: 'List tasks',
       description: "List the organization's tasks, optionally only the open or the done ones.",
       input: ListTasksInputSchema,
       output: ListTasksOutputSchema,
       http: { method: 'GET', path: '/v1/tasks' },
       mcp: { name: 'list_tasks', idempotent: true },
     },
     handler
   );
   ```

3. Mount the transport:

   ```ts
   import { mcp } from '@arbol-ai/maximus/mcp';
   import { createWorker } from '@arbol-ai/maximus/workers';

   const worker = createWorker(app, { transports: [mcp()] });
   export default worker.handler;
   ```

An operation can be a tool without an HTTP route: declare `mcp` and omit `http`. Configuring `mcp`
on the application without mounting the transport fails at startup, and so does a tool on an
application without `mcp` configuration.

Tool names match `^[a-z][A-Za-z0-9_]{0,63}$` and are unique. `idempotent` is required: say whether
repeating the call with the same input has no further effect. `openWorld` defaults to `true`; set it
to `false` when the tool touches only your service's own state.

## Authorization

The endpoint is `/mcp` (`mcp({ path })` moves it). Every MCP request carries a bearer token, verified
exactly as for HTTP, and the token must hold `<namespace>:mcp:use` to open the endpoint at all.

Each request then sees only the tools whose operation scopes the token carries, and whose
`actorKinds`, if declared, include the token's actor. Listing and calling use the same filter: a tool
the caller cannot see cannot be called by name. A tool call runs through the shared execution path,
so its input, output and failures are checked once, like an HTTP call.

An unauthenticated request answers `401` with
`WWW-Authenticate: Bearer resource_metadata="…"`. MCP clients follow it to
`/.well-known/oauth-protected-resource` (or its `/mcp` variant), which names `tokens.audience` (its
first audience, when it lists several) as the resource and `tokens.issuer` as the authorization
server. Applications with `tokens.scheme: { type: 'bearer' }` cannot mount MCP, because MCP clients
discover authorization through OAuth.

Use focused scopes so a person sees a useful set of tools, and keep credential management and
permission changes out of model-facing tools.

## What a tool looks like

`tools/list` describes each tool from its operation:

| Tool field                    | From                                                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                        | `mcp.name`                                                                                                                                                                        |
| `title`, `description`        | `title`, `description`. Write the description for a model: when to call it and what it never does.                                                                                |
| `inputSchema`, `outputSchema` | The operation's schemas, self-contained: each [named schema](schemas-and-validation.md#shared-schemas) written in place without its `$id`, and a recursive one once under `$defs` |
| `annotations.readOnlyHint`    | `effect === 'read'`                                                                                                                                                               |
| `annotations.destructiveHint` | `effect === 'delete'`                                                                                                                                                             |
| `annotations.idempotentHint`  | `mcp.idempotent`                                                                                                                                                                  |
| `annotations.openWorldHint`   | `mcp.openWorld ?? true`                                                                                                                                                           |

Hints help clients present tools; they are not consent and not authorization.

An input is always an object at the root, as MCP requires: hosts that refuse a root `anyOf`, the
Anthropic API among them, fail every tool of the request. A union input such as
`{ channel: 'email', address } | { channel: 'sms', phone }` lists as one object with every
member's fields: the ones every member requires are required, and a field the members declare
differently lists their choices, an `enum` for a discriminator. Each call is still checked against
the exact union, so a call that mixes members answers `INVALID_INPUT` before the handler runs.

A successful call answers the output as `structuredContent` and as JSON text. A failure answers a tool
result with `isError: true` whose text is the failure JSON, so a model can read the code and the
`data.issues` of an invalid input and correct itself:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"code\":\"INVALID_INPUT\",\"message\":\"The request does not match the published schema.\",\"retryable\":false,\"data\":{\"issues\":[{\"path\":\"/taskId\",\"message\":\"Expected string to match '…'\"}]}}"
    }
  ],
  "isError": true
}
```

An unexpected failure of the server itself, such as a rate limit binding that throws, answers the
JSON-RPC internal error (`-32603`) with the message `Internal error`, never the failure's own text, and
is reported as `maximus.unexpected`. A client's mistake, such as an unsupported protocol revision, is
answered and not reported.

Tool lists are paginated: 50 operation tools per page, with a cursor bound to the application's
version. A cursor the server did not issue to the caller, or one from another version, answers the
JSON-RPC error invalid params (`-32602`); the client lists again from the start.

The server identifies itself with the application's `name`, `title` and `version`. Its lists change
only with a deployment, so it declares `listChanged: false` for tools, resources and prompts and sends
no change notifications; a `subscriptions/listen` stream (protocol revision 2026-07-28) is acknowledged
with no notifications and closed at once.

## Resources, guides and prompts

Every MCP server also exposes:

- the OpenAPI document as two resources, `openapi-json` and `openapi-yaml`, named by the URLs that
  serve it: `<origin>/openapi.json` and `<origin>/openapi.yaml`, below `http.basePath` when there is
  one. Reading the whole public contract grants no authority to run it.
- `mcp.instructions`, returned when a client initializes.
- `mcp.guides`: Markdown usage guides, each served as a resource (`<origin>/guides/<name>`) and as a
  prompt of the same name.

```ts
mcp: {
  guides: [
    {
      name: 'task-conventions',
      title: 'Task conventions',
      text: 'A task title is one short sentence in the imperative.',
    },
  ],
},
```

Guide names match `^[a-z][a-z0-9-]{0,63}$` and are unique.

## Agent Skills

`mcp.skills` serves [Agent Skills](https://modelcontextprotocol.io/extensions/skills/overview)
through the MCP Skills extension (`io.modelcontextprotocol/skills`). The server declares the
extension, answers `skills/list` and `skills/get`, and serves each skill as the resource
`skill://<name>/SKILL.md`, with frontmatter generated from its name and description. Listings carry
each file's size and SHA-256 digest, which hosts verify before loading it, and a public cache hint.

```ts
import type { McpSkill } from '@arbol-ai/maximus';

const WEEKLY_REVIEW: McpSkill = {
  name: 'weekly-review',
  description: 'Review the open tasks with the user and close the ones that are already done.',
  text: '# Weekly review\n\n1. Call `list_tasks` with `status: "open"`.\n2. …',
};

maximus<Env>({
  // ...
  mcp: { skills: [WEEKLY_REVIEW], skillTool: 'read_skill' },
});
```

- `name`: lowercase letters and digits joined by single hyphens, at most 64 characters, unique.
- `description`: one line of at most 1024 characters saying what the workflow achieves and when.
- `text`: the Markdown instructions.

Skills are static and shared by every caller: never put tenant data in them, and remember they grant
no tool or scope. Host support for the extension is still young, and some clients import only tools.
`mcp.skillTool` also serves the skills through one read-only tool with that name, which leads the
first `tools/list` page and names every skill in its description, so tool search can find it.

## Body limits

A tool call carries one operation's input. The endpoint admits the largest `maxBodyBytes` among the
tools the caller may call (or the application limit), refusing a larger body with `413` before it is
parsed, and holds each call to its own operation's limit; a larger call answers the
`REQUEST_TOO_LARGE` tool error.

A JSON-RPC batch, which only 2025-03-26 clients send, is one request for the body limit, and every
request after its first, a resource read as much as a tool call, passes the rate limit like a request
of its own. A refused tool call answers the `RATE_LIMITED` tool error; any other refused request
answers the JSON-RPC error `-32000`, whose `data` is the `RATE_LIMITED` failure.

## Mounting at the root

`mcp({ path: '/' })` serves MCP at the root of its host, for a dedicated MCP hostname. `GET` and
`POST /` then go to MCP admission instead of the landing JSON. Combine it with `http.origins` to pin
the host. An application serves at most one MCP transport.

## Try it with curl

The transport is stateless: each request stands alone, so you can call a method directly.

```sh
curl -s http://localhost:5173/mcp \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_tasks","arguments":{"status":"open"}}}'
```

Responses arrive as a server-sent event: a line `event: message` followed by `data: {…}`. Any MCP
client that speaks Streamable HTTP and lets you set an `Authorization` header can connect to the same
URL. The [`http-and-mcp`](../../examples/http-and-mcp) example is a complete service.

## Design checklist

- Every tool description says when to use it, what it returns and what it never does.
- Effects and `idempotent` are true statements. A `POST` search is still `effect: 'read'`.
- Writes have business checks and documented reconciliation; see
  [Errors and results](errors-and-results.md#uncertain-outcomes).
- Credential submission, password entry and permission changes are not tools.
- Sampling, elicitation, list-change notifications and other MCP capabilities are not advertised;
  Maximus serves tools, resources, prompts and skills only.
