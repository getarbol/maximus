# @arbol-ai/maximus

Maximus defines an organization-scoped service once and serves it on Cloudflare Workers over HTTP
with its OpenAPI 3.1 contract, as MCP tools and as Worker RPC methods. It is one package: the root is
the core (the fluent builder, TypeBox schemas, tokens and scopes, the error catalog, middleware, the
native HTTP handler and OpenAPI), and each other capability is an entry.

```sh
bun add @arbol-ai/maximus
```

```ts
import { defineErrors, maximus, ok, t } from '@arbol-ai/maximus';

export const app = maximus<Env>({
  name: 'notes',
  namespace: 'notes',
  title: 'Notes',
  version: '1.0.0',
  origin: 'https://notes.example.com',
  tokens: { issuer: 'https://auth.example.com/', audience: 'https://notes.example.com' },
  errors: defineErrors({}),
  rpc: { callers: [] },
})
  .operation(
    'listNotes',
    {
      scope: 'notes:notes:read',
      effect: 'read',
      title: 'List notes',
      description: "List the organization's notes.",
      input: t.Object({}, { additionalProperties: false }),
      output: t.Object({ notes: t.Array(t.String()) }, { additionalProperties: false }),
      http: { method: 'GET', path: '/v1/notes' },
    },
    async () => ok({ notes: [] })
  )
  .build();
```

Entries: the root (the core), `/workers` (the Worker), `/mcp` (MCP tools), `/client` (a typed
client), `/schemas` (browser-safe schemas), `/errors` and `/failures` (runtime-free), `/body`,
`/webhooks`, `/http-paths`, `/projection`, `/diagnostics`, `/internals` (the transport SPI), `/analytics`,
`/postgres` (with the optional peer `pg`), `/testing`, `/oxlint` and `/oxfmt`. It installs the
`maximus` CLI and ships the Maximus Agent Skill in `skills/maximus/`.
See [package exports](https://github.com/getarbol/maximus/blob/main/docs/reference/exports.md).

- [Getting started](https://github.com/getarbol/maximus/blob/main/docs/getting-started.md)
- [Concepts](https://github.com/getarbol/maximus/blob/main/docs/concepts.md)
- [Configuration reference](https://github.com/getarbol/maximus/blob/main/docs/reference/configuration.md) and [operation reference](https://github.com/getarbol/maximus/blob/main/docs/reference/operations.md)

Released under the MIT License.
