# HTTP and MCP

A tasks service whose operations are both HTTP routes and MCP tools. It shows the resource-module
layout, typed preparation with `.derive()`, effects and idempotency as MCP annotations, a guide
served as a resource and a prompt, and an Agent Skill with a skill tool.

| File                          | Contains                                                            |
| ----------------------------- | ------------------------------------------------------------------- |
| `src/application.ts`          | The base application, its error catalog and its MCP configuration.  |
| `src/skills.ts`               | The `weekly-review` Agent Skill.                                    |
| `src/api/tasks/schemas.ts`    | The task schemas.                                                   |
| `src/api/tasks/tasks.ts`      | Named domain functions over one organization's tasks.               |
| `src/api/tasks/operations.ts` | Four operations: list, create, complete and delete.                 |
| `src/app.ts`                  | Mounts the resource module.                                         |
| `src/index.ts`                | The Worker with the MCP transport.                                  |
| `cloudflare.config.ts`        | The Worker for `cf`, with its KV binding and the development token. |

## Run it

```sh
echo "DEVELOPMENT_TOKEN=$(openssl rand -hex 32)" > .dev.vars
bun run dev                     # cf dev, on http://localhost:5173
TOKEN=$(sed 's/^DEVELOPMENT_TOKEN=//' .dev.vars)
```

## Over HTTP

```sh
curl -s -X POST http://localhost:5173/v1/tasks \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"Water the plants"}'

curl -s 'http://localhost:5173/v1/tasks?status=open' -H "authorization: Bearer $TOKEN"

# DELETE reads a JSON body like every non-GET operation: send {} when the input is all in the path.
curl -s -X DELETE http://localhost:5173/v1/tasks/<taskId> \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'
```

## Over MCP

```sh
mcp() {
  curl -s http://localhost:5173/mcp \
    -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d "$1"
}

mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
mcp '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_tasks","arguments":{"status":"open"}}}'
mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_skill","arguments":{"name":"weekly-review"}}}'
mcp '{"jsonrpc":"2.0","id":4,"method":"prompts/get","params":{"name":"task-conventions"}}'
```

`tools/list` shows `read_skill` first, then the four task tools with annotations derived from their
effects: `list_tasks` is read-only, `delete_task` is destructive. To connect an MCP client, point it
at `http://localhost:5173/mcp` (Streamable HTTP) with the header `Authorization: Bearer <token>`.

See the [MCP guide](../../docs/guides/mcp.md).
