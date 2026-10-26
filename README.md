# Maximus

[![Verify](https://github.com/getarbol/maximus/actions/workflows/verify.yml/badge.svg)](https://github.com/getarbol/maximus/actions/workflows/verify.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Maximus is a TypeScript framework for organization-scoped APIs on Cloudflare Workers. You declare
each operation once, with its schemas, scope, effect and handler, and Maximus serves it over HTTP
with a runtime OpenAPI 3.1 contract, as an MCP tool for AI agents, and as a typed Worker RPC method.
Each transport admits the caller its own way (a verified token and its scopes, or a trusted Service
Binding), then every call runs the same pipeline: decode and validate the input, prepare the
context, run your handler, validate what it returns. It is built for teams whose services are called
by people, by other services and by agents, in many tenants at once.

Create a project with `bunx @arbol-ai/maximus init my-service --name my-service --layout project`.
It starts with Vite+, root `maximus.config.ts`, named `GET`/`POST` route declarations, ordered
middleware, generated Worker entries and automatic deployment on main. `src/` is optional. See [Project structure](docs/guides/project-structure.md) for optional file conventions.

The repository root uses Vite+ for checks, formatting, workspace tasks and library/Worker builds.
`bun run verify` performs non-test validation; tests run only when explicitly requested.

```ts
import { defineErrors, err, maximus, ok, t } from '@arbol-ai/maximus';
import { mcp } from '@arbol-ai/maximus/mcp';
import { createWorker } from '@arbol-ai/maximus/workers';

interface Env {
  NOTES: KVNamespace;
}

const errors = defineErrors({
  noteNotFound: { code: 'NOTE_NOT_FOUND', status: 404, message: 'The note does not exist.' },
});

const app = maximus<Env>({
  name: 'notes',
  namespace: 'notes',
  title: 'Notes',
  version: '1.0.0',
  origin: 'https://notes.example.com',
  tokens: { issuer: 'https://auth.example.com/', audience: 'https://notes.example.com' },
  errors,
  rpc: { callers: ['reporting'] },
  mcp: { instructions: "Read the notes of the caller's organization." },
})
  .operation(
    'getNote',
    {
      scope: 'notes:notes:read',
      effect: 'read',
      title: 'Get a note',
      description: 'Read one note by its identifier.',
      input: t.Object({ noteId: t.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false }),
      output: t.Object({ noteId: t.String(), text: t.String() }, { additionalProperties: false }),
      http: { method: 'GET', path: '/v1/notes/{noteId}' }, // HTTP route + OpenAPI
      mcp: { name: 'get_note', idempotent: true }, // MCP tool
      rpc: true, // Worker RPC method
    },
    async ({ env, principal }, { noteId }) => {
      const text = await env.NOTES.get(`${principal.organizationId}/${noteId}`);
      return text === null ? err(errors.noteNotFound.create()) : ok({ noteId, text });
    }
  )
  .build();

const worker = createWorker(app, { transports: [mcp()] });

export const NotesService = worker.entrypoint;
export default worker.handler;
```

That Worker serves:

- `GET /v1/notes/{noteId}` with an OAuth bearer token holding `notes:notes:read`, answering
  `{ "success": true, "data": { … }, "error": null, "metadata": { "requestId": "…" } }`, or `404`
  with the `NOTE_NOT_FOUND` failure in the same envelope;
- `GET /openapi.json` (and YAML), generated from the definition, with scopes as OAuth security
  requirements and every failure the catalog can return;
- the `get_note` tool at `/mcp`, listed only to tokens that carry its scope;
- `getNote(principal, input)` on `NotesService` for the Worker whose Service Binding names it
  `reporting`.

The handler's `input` and `context` are inferred, the organization comes from the verified token,
and an input with unknown fields, such as another `organizationId`, is refused before the handler
runs.

## One package

```sh
bun add @arbol-ai/maximus
```

Everything is in `@arbol-ai/maximus`, one entry per concern. A bundle carries only the entries it
imports, and the browser entries load no Worker or Node runtime.

| Entry                                | Purpose                                                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `@arbol-ai/maximus`                  | Definitions, schemas, tokens and scopes, errors, middleware, native HTTP and OpenAPI.                           |
| `@arbol-ai/maximus/workers`          | The Worker: fetch handler, named RPC entrypoints, entrypoint and Durable Object instrumentation, static assets. |
| `@arbol-ai/maximus/mcp`              | MCP over Streamable HTTP with the official SDK: tools, resources, prompts and Agent Skills.                     |
| `@arbol-ai/maximus/client`           | A typed HTTP client inferred from the application's type, for browsers and Workers.                             |
| `@arbol-ai/maximus/schemas`          | Schemas, codecs and readers without the rest of the core, for browsers.                                         |
| `@arbol-ai/maximus/analytics`        | An observer that records allowlisted execution metadata to your sink.                                           |
| `@arbol-ai/maximus/postgres`         | Short tenant-scoped Postgres transactions (needs the optional peer `pg`).                                       |
| `@arbol-ai/maximus/testing`          | A contract smoke helper for tests.                                                                              |
| `@arbol-ai/maximus/oxlint`, `/oxfmt` | Lint and format presets.                                                                                        |

It also installs the `maximus` CLI and ships the Maximus Agent Skill. Every entry is listed in
[package exports](docs/reference/exports.md).

## Why Maximus

- **One definition, every transport.** HTTP, OpenAPI, MCP and RPC are projections of the same
  operation, so the contract cannot drift between them.
- **One owner for each check.** Admission, input validation, execution and output validation each
  happen once, in a fixed order, and no transport re-implements them. Invalid output is never sent.
- **Tenancy by construction.** Every call has a verified principal with an organization; strict
  schemas keep input from overriding it.
- **Failures are data.** Handlers return `Result`s from a declared catalog that fixes each code's
  status and retry semantics, so HTTP, MCP and RPC callers see the same failure.
- **Native and small.** Web `fetch` routing, TypeBox and TypeScript inference. No code generation,
  no runtime code compilation, no web framework underneath.
- **Private by default.** Diagnostics carry codes, ids and durations, never bodies, credentials or
  error text.

The trade-offs are deliberate:

- It targets Cloudflare Workers. The HTTP handler is standard `fetch`, but RPC and assets are
  Workers features, and other runtimes are not a supported target.
- Every operation requires a bearer token with an organization. The default verifier reads standard
  OAuth access tokens (RFC 9068) from any authorization server: Auth0's as they are, and others, such
  as Okta's or WorkOS's, once `tokens.claims` says where their claims are. A person holds only the
  scopes their permissions also list. Other credentials need a resolver. Organization ids are 1 to
  128 letters, digits, `_` and `-`, as identity providers issue them (`org_…`, UUIDs, slugs).
- Routes are fixed and versioned (`/v1/...`), with whole-segment parameters and no
  regular-expression routing or path normalization. Bodies are JSON, plus explicit byte uploads.
- Schemas are TypeBox; there is no Zod adapter.

## Documentation

- [Getting started](docs/getting-started.md): build, run and call a service.
- [Concepts](docs/concepts.md): the model and its vocabulary.
- [Guides](docs/README.md#guides): HTTP, MCP, RPC, errors, middleware, authentication, testing,
  deploying and more.
- [Reference](docs/README.md#reference): configuration, operations, CLI, wire formats, failures and
  exports.
- [Architecture](docs/architecture.md): the design decisions.

Runnable [examples](examples): a minimal HTTP service, HTTP and MCP together, and two Workers over
RPC.

An [Agent Skill](.agents/skills/maximus/SKILL.md) teaches coding agents to build with Maximus; it
ships in `@arbol-ai/maximus` under `skills/maximus`.

## Status and versioning

Maximus runs Arbol's production services; Arbol builds and maintains it. Releases follow semantic
versioning: a breaking change moves the major version, and published releases never change. See the
[changelog](CHANGELOG.md) and the [migration guides](docs/README.md#guides).

The package is published on npm as
[`@arbol-ai/maximus`](https://www.npmjs.com/package/@arbol-ai/maximus). Up to 6.x it was
`@getarbol/maximus`, a private package; the [changelog](CHANGELOG.md) says what 7.0.0 changed.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) to set up the workspace and propose changes, and report
vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Everyone taking part follows
the [code of conduct](CODE_OF_CONDUCT.md).

## License

Maximus is released under the [MIT License](LICENSE).
