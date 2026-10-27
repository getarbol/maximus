# create-maximus

Creates a [Maximus](https://github.com/getarbol/maximus) project: an API on Cloudflare Workers, configured in
one `vite.config.ts`, whose routes are also MCP tools when they say so.

```sh
bun create maximus my-api
```

In a terminal, it asks for what the arguments leave out: the project's directory, whether it serves its
routes to agents over MCP (yes by default) and whether it is also a React web app (no by default). The
arguments answer instead:

```sh
bun create maximus my-api --web          # an API, its MCP server and a React app
bun create maximus my-api --no-mcp       # an API alone
bun create maximus my-api --yes          # the defaults, without questions
npm create maximus@latest my-api         # the same with npm
```

Then:

```sh
cd my-api
bun install
bun run dev
```

The project depends on the Maximus release that created it. `bun run verify` runs its types, lint and
format, tests and build, and its README says how to deploy it. The
[CLI reference](https://github.com/getarbol/maximus/blob/main/docs/reference/cli.md#create-maximus) lists
every option, and [Getting started](https://github.com/getarbol/maximus/blob/main/docs/getting-started.md)
builds on the new project step by step.

Released under the MIT License.
