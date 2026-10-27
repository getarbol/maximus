# Maximus

[![CI](https://github.com/getarbol/maximus/actions/workflows/ci.yml/badge.svg)](https://github.com/getarbol/maximus/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@arbol-ai/maximus.svg)](https://www.npmjs.com/package/@arbol-ai/maximus)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Maximus is a TypeScript framework for organization-scoped APIs on Cloudflare Workers. Each route is a file
that declares its handler and its contract once. Maximus serves it over HTTP with a live OpenAPI 3.1
document, as an MCP tool when you name one, and as a native RPC method to the Workers you allow. Whatever
the transport, a call is admitted by a verified token and its scopes, or by a trusted Service Binding, and
then runs one pipeline: decode and validate the input, prepare the context, run the handler, check what it
returns.

It is built for teams whose services are called by people, by other services and by AI agents, in many
organizations at once, and whose data does not leave the organization it belongs to.

## Start

```sh
bun create maximus my-api
cd my-api
bun install
bun run dev                      # http://localhost:5173
```

The new project answers `GET /api/v1/greeting` to a signed-in caller, serves it to agents as the MCP tool
`get_greeting`, publishes `/api/openapi.json` and ships with tests, lint, a GitHub workflow and the Maximus
skill linked for coding agents. [Getting started](docs/getting-started.md) builds on it step by step.

## A route is a file

```ts
// routes/v1/notes/[noteId].get.ts: GET /api/v1/notes/{noteId}
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

The file's name is its method and path. Maximus derives the operation's name (`getNote`), its
effect (`read`) and the scope a caller needs (`notes:notes:read`); the contract states the rest. `input`
is decoded and typed from its schema, `fail` accepts only the codes your `errors.ts` declares, and `notes`
is what `context.ts` prepares for every call, here the notes of the caller's organization. The same file
is the MCP tool `get_note`.

## One configuration

```ts
// vite.config.ts
import { maximus } from '@arbol-ai/maximus/vite';
import { bindings } from 'cf/config';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [
    maximus({
      origin: 'https://notes.example.com',
      tokens: { issuer: 'https://auth.example.com/' },
      compatibilityDate: '2026-10-26',
      env: { NOTES: bindings.kv() },
    }),
  ],
});
```

`maximus()` states the application and the Worker that serves it, with Cloudflare's own names for the
Worker's settings and bindings. From it and the project's files, Maximus generates `.maximus/`: the
application, the Worker's entry and an `Env` type inferred from the bindings. `vp dev` runs the Worker
locally in workerd, `vp test` runs your tests in Node, `vp build` builds it and `cf deploy` deploys that
build.

## What a deployed Worker serves

| Path                                        | Serves                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `/api/v1/…`                                 | Your routes, to callers whose token holds their scopes.                     |
| `/api/openapi.json`, `/api/openapi.yaml`    | The OpenAPI 3.1 document, built from the routes and the error catalog.      |
| `/mcp`                                      | MCP over Streamable HTTP: the tools, guides and Agent Skills you declare.   |
| `/api/.well-known/oauth-protected-resource` | OAuth discovery, which a refused call's `WWW-Authenticate` challenge names. |
| `/health`                                   | Liveness, with the service's name and version.                              |
| `/`, and every path a web app owns          | The React app `index.html` starts, with a strict content security policy.   |

## How it behaves

- **One definition, every transport.** HTTP, OpenAPI, MCP and RPC are views of the same route, so the
  contract cannot drift between them.
- **One owner for each check.** Admission, input validation, execution and output validation each happen
  once, in a fixed order, and no transport repeats them. An answer its schema refuses is never sent.
- **Tenancy by construction.** Every call carries a verified principal with an organization, which input
  can never override; storage keys, queries and Durable Object names start from it.
- **Failures are data.** A route answers `fail(code)` from a declared catalog that fixes each code's status
  and retry semantics, so HTTP, MCP and RPC callers see the same failure.
- **Private by default.** Diagnostics carry codes, ids and durations, never bodies, credentials or error
  text, and analytics name each actor by a pseudonym unless you choose otherwise.
- **Small Workers.** A Worker without MCP builds to under 200 kB. With MCP, the SDK is a separate chunk that
  loads with the first MCP request.

The trade-offs are deliberate. Maximus targets Cloudflare Workers. Every route requires a bearer token
with an organization: standard OAuth access tokens from your authorization server, or your own verifier.
Routes are versioned (`/v1/…`) with whole-segment parameters. Bodies are JSON, plus explicit byte uploads.
Schemas are [TypeBox](https://github.com/sinclairzx81/typebox).

## Packages

| Package                                                                | What it is                                                                                                                                                                        |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@arbol-ai/maximus`](https://www.npmjs.com/package/@arbol-ai/maximus) | The framework, one entry per concern: `maximus()` from `@arbol-ai/maximus/vite`, the project's only configuration, the `maximus` command and the Maximus skill for coding agents. |
| [`create-maximus`](https://www.npmjs.com/package/create-maximus)       | `bun create maximus`: a new project.                                                                                                                                              |

The two are released together, at one version. A Worker carries only the entries it imports:
`@arbol-ai/maximus/mcp` and `@arbol-ai/maximus/postgres`, for instance, stay out of one that does not use
them. Every entry is listed in [package exports](docs/reference/exports.md).

## Examples

Runnable services in [`examples/`](examples), each configured in its `vite.config.ts` alone, tested in
Node and deployable to Cloudflare:

| Example                                       | Shows                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [`tasks`](examples/tasks)                     | Routes as files, MCP tools, guides and an Agent Skill, and a React app on the same Worker. |
| [`d1-notes`](examples/d1-notes)               | D1 with migrations, rows keyed by organization, keyset pages and search for agents.        |
| [`worker-rpc`](examples/worker-rpc)           | Two Workers over native RPC, typed by the contract one of them publishes.                  |
| [`queue-reminders`](examples/queue-reminders) | A queue consumer that delivers once, a dead letter queue and a cron that recovers.         |
| [`browser-pages`](examples/browser-pages)     | Browser Run: pages as Markdown for agents, or as PNG attachments.                          |
| [`r2-documents`](examples/r2-documents)       | Byte uploads checked against their type, SHA-256 checksums and streamed downloads from R2. |
| [`do-appointments`](examples/do-appointments) | A Durable Object per organization and day that never double-books a slot.                  |

## Documentation

- [Getting started](docs/getting-started.md): create, run, test and deploy a service.
- [Concepts](docs/concepts.md): the model and its vocabulary.
- [Guides](docs/README.md#guides): routes, schemas, errors, authentication, MCP, bindings, RPC, background
  work, web apps, testing, deploying and more.
- [Reference](docs/README.md#reference): configuration, route options, the CLI, wire formats, failures and
  exports.
- [Upgrading to 8.0](docs/upgrading-to-8.md) from a 7.x service.

The [Maximus skill](.agents/skills/maximus/SKILL.md) teaches coding agents to build with Maximus; every
project links the copy its installed release ships.

## Status and versioning

Maximus runs Arbol's production services; Arbol builds and maintains it. Releases follow semantic
versioning, and the [changelog](CHANGELOG.md) records every change.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) to set up the workspace and propose a change. Report
vulnerabilities privately, as [SECURITY.md](SECURITY.md) describes. Everyone taking part follows the
[code of conduct](CODE_OF_CONDUCT.md).

## License

Maximus is released under the [MIT License](LICENSE).
