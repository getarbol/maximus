# Tasks: a project-layout service

One file per route and method, each a `defineHandler` default export. The filename is the path and
the method; Maximus derives the operation name, the effect and the scope, and the handler receives one
object with its input, the verified principal, the task store and `fail`.

```text
errors.ts                                 TASK_NOT_FOUND, typed in every handler's fail
maximus.config.ts                         Identity, token policy and the task store
routes/v1/tasks/index.get.ts              GET    /api/v1/tasks                 (+ MCP list_tasks)
routes/v1/tasks/index.post.ts             POST   /api/v1/tasks
routes/v1/tasks/[taskId].get.ts           GET    /api/v1/tasks/{taskId}
routes/v1/tasks/[taskId].delete.ts        DELETE /api/v1/tasks/{taskId}
routes/v1/tasks/[taskId]/complete.post.ts POST   /api/v1/tasks/{taskId}/complete (+ MCP complete_task)
mcp/tools/summarize-tasks.ts              MCP only: summarize_tasks
src/tasks.ts                              The organization's tasks in Workers KV
```

Reads need `tasks:tasks:read` and the rest `tasks:tasks:write`; the MCP-only tool needs
`tasks:summarize-tasks:read`, and every MCP call `tasks:mcp:use`. The development token holds them all.

```sh
bun install          # once, at the repository root
cd examples/project-tasks
echo "DEVELOPMENT_TOKEN=$(openssl rand -hex 32)" > .dev.vars
bun run dev          # on http://localhost:5173; the API is under /api
```

`bun run verify` prepares the project, generates the Cloudflare types, type-checks and builds.
