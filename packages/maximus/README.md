# @arbol-ai/maximus

Maximus builds organization-scoped APIs on Cloudflare Workers that people and AI agents call alike. Each
route is a file that declares its handler and its contract once, and the same Worker serves it over HTTP
with an OpenAPI 3.1 document, as an MCP tool when the route names one, and over native RPC to the Workers
you allow.

```sh
bun create maximus my-api
```

```ts
// routes/v1/notes/[noteId].get.ts: GET /api/v1/notes/{noteId}, and the MCP tool get_note
import { defineHandler, UuidSchema } from '@arbol-ai/maximus';

import { NoteSchema } from '../../../src/notes.ts';

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

This package is the framework. Its root entry holds routes and operations, TypeBox schemas, tokens and
scopes, the error catalog and the HTTP handler with its OpenAPI document; each optional capability is an
entry of its own, such as `@arbol-ai/maximus/mcp`, `/workers` or `/postgres`, and a Worker carries only the
entries it imports. The package installs the `maximus` command and ships the Maximus skill for coding agents
in `skills/maximus/`. [`@arbol-ai/vite-plugin`](https://www.npmjs.com/package/@arbol-ai/vite-plugin) makes
`vite.config.ts` a project's one configuration.

- [Getting started](https://github.com/getarbol/maximus/blob/main/docs/getting-started.md)
- [Concepts](https://github.com/getarbol/maximus/blob/main/docs/concepts.md)
- [Package exports](https://github.com/getarbol/maximus/blob/main/docs/reference/exports.md), every entry
- [CLI](https://github.com/getarbol/maximus/blob/main/docs/reference/cli.md), the `maximus` command
- [All documentation](https://github.com/getarbol/maximus/blob/main/docs/README.md)

Released under the MIT License.
