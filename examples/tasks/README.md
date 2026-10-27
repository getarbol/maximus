# Tasks: a project-layout service and its web app

One file per route and method, each a `defineHandler` default export. The filename is the path and
the method; Maximus derives the operation name, the effect and the scope, and the handler receives one
object with its input, the verified principal, the task store and `fail`. The same Worker serves a small
React app whose pages are the files of `app/routes/` and which calls the API with `fetch`, typed by the routes' schemas.

```text
vite.config.ts                            The only configuration: the application and its Worker
errors.ts                                 TASK_NOT_FOUND, typed in every handler's fail
context.ts                                The caller's organization's tasks, in every handler
routes/v1/tasks/index.get.ts              GET    /api/v1/tasks                 (+ MCP list_tasks)
routes/v1/tasks/index.post.ts             POST   /api/v1/tasks
routes/v1/tasks/[taskId].get.ts           GET    /api/v1/tasks/{taskId}
routes/v1/tasks/[taskId].delete.ts        DELETE /api/v1/tasks/{taskId}
routes/v1/tasks/[taskId]/complete.post.ts POST   /api/v1/tasks/{taskId}/complete (+ MCP complete_task)
mcp/tools/summarize-tasks.ts              MCP only: summarize_tasks
mcp/instructions.md                       What MCP clients read when they connect
mcp/guides/task-conventions.md            A guide, as an MCP resource and prompt
mcp/skills/weekly-review.md               An Agent Skill: skill://weekly-review/SKILL.md
src/tasks.ts                              The organization's tasks in Workers KV
tests/tasks.test.ts                       The API and MCP in Node, over a Workers KV stand-in
index.html                                The web app, which loads app/main.tsx
app/api.ts                                The API's routes as typed fetch calls, and the token in memory
app/root.tsx                              The layout around every page, and its error boundary
app/routes/index.tsx                      /               Sign in with a token
app/routes/tasks/index.tsx                /tasks          The tasks, and a form that adds one
app/routes/tasks/[taskId].tsx             /tasks/:taskId  Complete or delete a task
```

Reads need `tasks:tasks:read` and the rest `tasks:tasks:write`; the MCP-only tool needs
`tasks:summarize-tasks:read`, and every MCP call `tasks:mcp:use`. The development token holds them all.

```sh
bun install          # once, at the repository root
cd examples/tasks
echo "DEVELOPMENT_TOKEN=$(openssl rand -hex 32)" > .dev.vars
bun run dev          # on http://localhost:5173; the API is under /api
```

Open the app, sign in with the `DEVELOPMENT_TOKEN` from `.dev.vars`, and add a task. The app keeps the
token in memory alone, so a reload asks for it again; a deployed app gets its tokens from your identity
provider.

`bun run test` runs the API and MCP in Node; `bun run verify` prepares the project, type-checks it and
builds the Worker. `Env` comes from the bindings in `vite.config.ts`.

## Deploy it

Set `tokens.issuer` to your authorization server first: a deployed Worker accepts its access tokens alone.

```sh
bunx cf auth login
export WORKERS_SUBDOMAIN=<your workers.dev subdomain>
bun run build && bunx cf deploy --prebuilt --mode production
```

The first deployment creates the `TASKS` namespace; the app and the API share the Worker's origin.
