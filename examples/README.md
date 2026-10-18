# Examples

Small, runnable Maximus services. Each one runs locally with `cf dev` and needs no Cloudflare account.

| Example                        | Shows                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`minimal-http`](minimal-http) | One application, three HTTP operations, OpenAPI, a domain failure, a test with the typed client. The code from [Getting started](../docs/getting-started.md). |
| [`http-and-mcp`](http-and-mcp) | The same operations over HTTP and MCP, resource modules, `.derive()`, guides and an Agent Skill.                                                              |
| [`worker-rpc`](worker-rpc)     | Two Workers: one calls the other's operation over native RPC, forwarding its principal.                                                                       |

Inside this repository the examples use the workspace packages (`workspace:^`). In your own project,
depend on a released version instead.

Run an example from its directory:

```sh
bun install          # once, at the repository root
cd examples/minimal-http
bun run dev          # cf dev, on http://localhost:5173
```

`bun run build` runs `cf build`, which writes the build `cf deploy` uploads.

The examples authenticate with a development token on `localhost`; see
[Decide how callers authenticate](../docs/getting-started.md#decide-how-callers-authenticate).
