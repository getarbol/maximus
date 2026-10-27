# MCP

A Maximus Worker serves its routes to AI agents over the
[Model Context Protocol](https://modelcontextprotocol.io) when you name them as tools. This guide covers
tools from routes and tools only agents call, the Markdown that describes the server to its clients
(instructions, guides and Agent Skills), who sees which tool, and how a client connects.

## The MCP server

The MCP server is the Worker's `/mcp` endpoint, served over Streamable HTTP with the official MCP SDK. It
stays at `/mcp` whatever the API's base path. The Worker serves it when the project has anything to
serve there: a route that names a tool, a file of `mcp/tools/`, or one of `mcp/instructions.md`,
`mcp/guides/` and `mcp/skills/`.

A tool is an operation like any route: the same schemas, scope, context, middleware, handler and
failures, run through the same [execution path](../concepts.md#one-execution-path). The server is
stateless: each request stands alone, and the SDK loads with the first MCP request, so the Worker's other
requests never load it.

## Serve a route as a tool

A route is a tool when its contract names one in `mcp`:

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

`bunx maximus gen route get '/v1/notes/{noteId}' --tool get_note` writes such a file. `mcp` takes:

| Field        | Default                                     | Meaning                                                                                            |
| ------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `name`       | Required                                    | The tool's name: a lowercase letter, then up to 63 letters, digits and `_`, unique in the service. |
| `idempotent` | `true` for `GET`, `PUT` and `DELETE` routes | Whether repeating a call with the same input has no further effect.                                |
| `openWorld`  | `true`                                      | Whether the tool reaches outside the service; `false` when it touches only the service's own data. |

A route that is a tool must have a `description`, which the agent reads to choose it: a route without
one is refused with `GET /v1/notes/{noteId}: a route that is an MCP tool describes what it does.` Its
title is the route's, `Get a note`, unless the contract sets `title`. A name that is not
valid, or that two tools share, is refused with
`Operation "<name>": MCP tools require unique safe names.` Exposure is always explicit: a route that
names no tool is no tool.

## Tools only agents call

A tool that has no HTTP route is a file of `mcp/tools/`, whose default export is
`defineTool(handler, contract)`:

```ts
// mcp/tools/summarize-notes.ts
import { defineTool, t } from '@arbol-ai/maximus';

/** The MCP tool summarize_notes: agents call it, and no HTTP route serves it. */
export default defineTool(
  async ({ notes }) => {
    const all = await notes.list();
    return { count: all.length, summary: `${all.length} notes.` };
  },
  {
    description: "Count the organization's notes for a review. It never changes a note.",
    effect: 'read',
    output: { count: t.Integer({ minimum: 0 }), summary: t.String() },
  }
);
```

`bunx maximus gen tool summarize-notes` writes the file. The file's name, in kebab-case directly in
`mcp/tools/`, names the tool: `summarize-notes.ts` is the tool `summarize_notes` and the operation
`summarizeNotes`. The handler receives what a route's does.

The contract requires `description` and `effect` (`read`, `write` or `delete`), and takes the fields a
route's does, except its HTTP options, `operationId` and `visibility`. What it leaves out is derived:

| Field        | Default                                                                           |
| ------------ | --------------------------------------------------------------------------------- |
| `scope`      | `<namespace>:<file>:read` for a read, else `:write`: `notes:summarize-notes:read` |
| `title`      | The tool's name in words: `Summarize notes`                                       |
| `idempotent` | `true` for a read                                                                 |
| `openWorld`  | `true`                                                                            |

A tool of `mcp/tools/` is absent from the OpenAPI document. Like a route, it may also be a
[Worker RPC](worker-rpc.md) method with `rpc`.

## Describe the server

Three kinds of Markdown file in `mcp/` describe the server to its clients. They are static and the same
for every caller: never put an organization's data in them.

| File                   | Served as                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `mcp/instructions.md`  | The server's instructions, which a client receives when it connects.                                                      |
| `mcp/guides/<name>.md` | A resource, `<origin>/guides/<name>` in `text/markdown`, and a prompt named `<name>`, titled by the file's first heading. |
| `mcp/skills/<name>.md` | An Agent Skill, `skill://<name>/SKILL.md`.                                                                                |

The instructions tell a client what the service is for and how its tools fit together. `mcp/instructions.md`:

```md
notes keeps short notes for the organization your token belongs to. Call get_note with a note's id to read
it, and summarize_notes for a count of them. Every call acts for that organization alone.
```

A guide starts with its title, as a first-level heading on its first line, or it is refused with
`Start the guide with its # title: mcp/guides/<name>.md`. `mcp/guides/note-style.md`:

```md
# Note style

- A note is one or two sentences in plain language.
- Never copy a person's contact details into a note.
```

The names of guides and skills are their files', in kebab-case and at most 64 characters, or the file is
refused with `Name MCP Markdown in kebab-case, at most 64 characters: <file>`. A guide and a skill never
share a name, and neither takes `openapi-json` or `openapi-yaml`, which name the OpenAPI document's
[resources](#resources):
`MCP resource name <name> is taken: guides and skills need names of their own, and openapi-json and openapi-yaml name the OpenAPI document.`
Other files in `mcp/`, such as a `README.md`, are not served.

### Agent Skills

A skill is a workflow an agent follows across several tools. Its file starts with frontmatter that
states its one-line `description`, which tells an agent what the workflow achieves and when to use it,
followed by its instructions. `mcp/skills/weekly-review.md`:

```md
---
description: Review the organization's notes once a week and summarize what changed.
---

# Weekly review

1. Call summarize_notes to see how many notes there are.
2. Read the notes the person asks about with get_note.
3. Report what changed since the last review.
```

The frontmatter states `description` alone, and `name` only when it repeats the file's name; anything
else is refused, and so is a skill without frontmatter or without a description. The server declares the
MCP Skills extension (`io.modelcontextprotocol/skills`), answers `skills/list` and `skills/get`, and
serves each skill as the resource `skill://<name>/SKILL.md`, whose frontmatter it writes from the name and
the description. Each listing carries the file's size and SHA-256 digest, which hosts check before
loading it, and a cache hint that lets hosts keep it, and share it between callers, for five minutes. A
skill grants no tool and no scope.

A client that reads only tools does not see skills. A Worker composed by hand can also serve them as one
read-only tool, `mcp.skillTool` (see [In a Worker composed by hand](#in-a-worker-composed-by-hand)).

## Who may call a tool

Every MCP request carries a bearer token, verified as for the API (see
[Authentication and scopes](authentication-and-scopes.md)), and the token must hold `<namespace>:mcp:use`,
`notes:mcp:use` here, to use the server at all. A request without a valid token answers `401` with the
`www-authenticate` challenge that leads an OAuth client to the authorization server, and a token without
the scope answers `403`. A service whose token scheme is `bearer` cannot serve MCP:
`The MCP transport needs OAuth discovery; it cannot serve a bearer token scheme.`

Each request then sees only the tools its token may call: those whose scopes it holds, by their
`scopeMatch`, and whose `actorKinds`, when they name any, include its actor. Listing and calling share
this filter. Calling a tool the caller does not see, or one that does not exist, answers the JSON-RPC
error invalid params (`-32602`) with the message `Tool not found`, so the caller cannot tell the two
apart. The development token holds every scope, so it sees every tool that admits a person.

A tool call runs through the shared execution path: its input is decoded and checked once, `context.ts`
prepares the context, operation middleware and the handler run, and the answer is checked once.

## What a tool looks like

`tools/list` describes each tool from its contract:

| Tool field                    | From                                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `name`                        | `mcp.name`, or the file's name                                                                                                   |
| `title`, `description`        | `title` and `description`. Write the description for a model: when to call it, what it never does.                               |
| `inputSchema`, `outputSchema` | The contract's schemas, self-contained: each named schema written in place without its `$id`, a recursive one once under `$defs` |
| `annotations.readOnlyHint`    | `true` when the effect is `read`                                                                                                 |
| `annotations.destructiveHint` | `true` when the effect is `delete`                                                                                               |
| `annotations.idempotentHint`  | `idempotent`                                                                                                                     |
| `annotations.openWorldHint`   | `openWorld`                                                                                                                      |

The annotations help a client present a tool and ask for confirmation; they are not consent and never
authorize anything. Make them true statements: a `POST` search declares `effect: 'read'`.

An input schema is an object at the root, as MCP requires: hosts that refuse a root `anyOf`, the
Anthropic API among them, fail every tool of a request that lists one. A union input, such as
`{ channel: 'email', address } | { channel: 'sms', phone }`, lists as one object with every member's
fields: those every member requires are required, and a field the members declare differently lists
their choices, an `enum` for a discriminator. Each call is still checked against the exact union, so a
call that mixes members answers `INVALID_INPUT` before the handler runs.

## Answers and failures

A successful call answers the output as `structuredContent` and as JSON text. A failure answers a tool
result with `isError: true` whose text is the failure as JSON, so a model can read its code and the
`data.issues` of an invalid input, and correct its call:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"code\":\"INVALID_INPUT\",\"message\":\"The request does not match the published schema.\",\"retryable\":false,\"data\":{\"issues\":[{\"path\":\"/noteId\",\"message\":\"Expected string to match '…'\"}]}}"
    }
  ],
  "isError": true
}
```

A failure of the server itself, such as one while it writes its OpenAPI document, answers the JSON-RPC
internal error (`-32603`) with the message `Internal error`, never the failure's own text, and is reported
as `maximus.unexpected`. A client's mistake, such as a protocol revision the server does not speak or a
missing header, is answered with a `4xx` status by the SDK and is not reported.

## Limits

A request's body is admitted up to the largest `maxBodyBytes` among the tools its caller may call, or the
service's limit when that is larger; a larger body answers `413` with `REQUEST_TOO_LARGE` before it is
parsed. Each tool call is then held to its own route's limit: a call larger than its tool admits answers
the `REQUEST_TOO_LARGE` tool error, and the handler does not run.

A [rate limit](authentication-and-scopes.md#rate-limits) counts each MCP request as one call. A JSON-RPC
batch, which only clients of protocol revision 2025-03-26 send, counts each of its messages, a ping or a
listing as much as a tool call, and every one is admitted before any of them runs: a batch the caller's
limit cannot admit whole answers `429` with `RATE_LIMITED`, and none of it runs. The body limit applies
to the batch as one request. A batch holds at most 100 messages, as the MCP SDK allows, so without a rate
limit one request with a valid token can run up to 100 tool calls; configure `rateLimit` where calls are
throttled or billed per request.

`tools/list` answers 50 tools a page, with a cursor bound to the service's version and to the tools the
caller sees. A cursor the server did not issue to this caller, or one from another version, answers the
JSON-RPC error invalid params (`-32602`) with the message `Invalid cursor`, and the client lists again
from the start.

## Protocol revisions

The server speaks both eras of the protocol:

- The revisions up to 2025-11-25, whose clients open with `initialize` and receive the server's
  instructions and capabilities in its answer.
- The 2026-07-28 revision, whose clients send the protocol version and their capabilities with every
  request, ask for the server's description with `server/discover`, and name each request's method in the
  `mcp-method` header and a tool call's tool in `mcp-name`. A tool call whose `mcp-name` does not name its
  tool answers `400`.

The server identifies itself by the service's `name`, `title` and `version`. Its lists change only with a
deployment, so it declares `listChanged: false` for tools, resources and prompts and sends no
notifications; a `subscriptions/listen` stream is acknowledged and closed at once. Its capabilities are
tools, resources and prompts, and the Skills extension when it serves skills; it never asks a client to
sample a model or to elicit input.

## Resources

Besides guides and skills, every MCP server serves the OpenAPI document as two resources, `openapi-json`
and `openapi-yaml`, named by the URLs that serve it: `https://notes.example.com/api/openapi.json` and
`/api/openapi.yaml`. Reading the whole public contract grants no authority to run any of it.

## What is observed

Each tool call is an execution observation with the surface `mcp`, as an HTTP call is with `http` (see
[Observability](observability.md)). A refusal the server answers itself is observed as a refused
admission: a tool the caller's scopes or actor kind hide as `FORBIDDEN` with its operation, a tool that
does not exist as `NOT_FOUND`, a call larger than its tool admits as `REQUEST_TOO_LARGE`, and a batch over
the rate limit as `RATE_LIMITED`. The client still learns only that the tool was not found, or the tool
error. No observation carries a tool's arguments or its output.

## Connect a client

An MCP client connects with the server's URL, `https://notes.example.com/mcp`, and a bearer token. A
client that implements OAuth starts from the URL alone: it follows the `401` challenge to the service's
protected resource metadata, and from there to the authorization server that issues its token (see
[OAuth discovery](authentication-and-scopes.md#oauth-discovery)). Locally, connect to
`http://localhost:5173/mcp` with the development token:

```sh
TOKEN=$(cut -d= -f2 .dev.vars)
curl http://localhost:5173/mcp \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

A request must accept both `application/json` and `text/event-stream`, and answers arrive as a
server-sent event: a line `event: message` followed by `data: {…}`. [Testing](testing.md) calls the
server in Node, through the handler the Worker serves.

## In a Worker composed by hand

A Worker composed by hand with the application builder (see [Worker composition](worker-composition.md))
mounts the transport, `mcp()` from `@arbol-ai/maximus/mcp`, and describes the server in the application's
`mcp` option:

```ts
import { maximus } from '@arbol-ai/maximus';
import { mcp } from '@arbol-ai/maximus/mcp';
import { createWorker } from '@arbol-ai/maximus/workers';

const app = maximus<Env>({
  // …
  mcp: {
    instructions: 'notes keeps short notes for the organization your token belongs to.',
    guides: [{ name: 'note-style', title: 'Note style', text: '# Note style\n\n…' }],
    skills: [
      { name: 'weekly-review', description: 'Review the notes once a week.', text: '# Weekly review\n\n…' },
    ],
    skillTool: 'read_skill',
  },
})
  // .operation(…) declares each tool with mcp: { name, idempotent, openWorld? }
  .build();

export default createWorker(app, { transports: [mcp()] }).handler;
```

- An operation declares `mcp: { name, idempotent, openWorld? }`, and states `idempotent` itself.
- `skillTool` serves the skills through one read-only tool of that name, which leads the first page of
  `tools/list` and names every skill in its description, for clients that import tools alone. It
  requires skills and a name no operation uses.
- `mcp({ path })` moves the endpoint. `mcp({ path: '/' })` serves MCP at the root of a host dedicated to
  it, where `/` would otherwise answer the service's index; pin that host with `http.origins`.
- The `mcp` option requires the transport, and a Worker serves one MCP transport at most: they are
  refused with `MCP configuration requires the optional MCP transport.` and
  `An HTTP handler may mount only one MCP transport.`

## Design checklist

- Every tool's description says when to use it, what it returns and what it never does.
- Effects and `idempotent` are true statements.
- Writes check their business rules, and answer `OUTCOME_UNKNOWN` when they cannot be sure their effect
  took place; see [Errors and results](errors-and-results.md).
- Entering a credential or a password, and changing a permission, are not tools.
- Instructions, guides and skills hold no organization's data.
