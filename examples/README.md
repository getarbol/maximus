# Examples

Runnable Maximus services, each configured in its `vite.config.ts` alone and deployable to Cloudflare. Every
one runs locally with `bun run dev`, and its tests run in Node with `bun run test`. Only `browser-pages`
needs a Cloudflare account before it deploys: its browser runs on Cloudflare's network.

| Example                              | Shows                                                                                                                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`tasks`](tasks)                     | Routes as files, typed failures, MCP tools from routes and from `mcp/tools/`, a guide and an Agent Skill in Markdown, and a React web app served by the same Worker. Workers KV. |
| [`d1-notes`](d1-notes)               | A D1 database with migrations, rows keyed by organization and read through their schema, keyset pages, and literal search as an MCP tool.                                        |
| [`worker-rpc`](worker-rpc)           | Two Workers: orders calls pricing over native RPC with the caller's principal, typed by the contract pricing publishes.                                                          |
| [`queue-reminders`](queue-reminders) | A queue whose consumer delivers reminders once, a dead letter queue, and a cron that queues again what was never delivered. Workers KV.                                          |
| [`browser-pages`](browser-pages)     | Browser Run: pages read as Markdown for agents or captured as a PNG attachment, with Chrome held to the allowed hosts.                                                           |
| [`r2-documents`](r2-documents)       | Byte uploads checked against their type's signature, SHA-256 checksums, and streamed attachment downloads from R2.                                                               |

Inside this repository the examples depend on the workspace packages (`workspace:^`). Your own project
depends on a release: `bun create maximus my-api` starts one.

```sh
bun install                        # once, at the repository root
bun run test                       # the packages' tests and every example's
cd examples/tasks && bun run dev   # one example, on http://localhost:5173
```

Locally the examples accept the development token in their `.dev.vars` from `localhost` alone; each README
shows how to create it. A deployed Worker accepts the access tokens of the issuer `tokens.issuer` names:
set it to your authorization server before deploying.
