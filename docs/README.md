# Maximus documentation

Maximus builds APIs on Cloudflare Workers that people and AI agents call alike: each route is a file that
declares its contract once, and the same Worker serves it over HTTP with an OpenAPI document, to MCP
clients when the route says so, and to other Workers over native RPC.

## Start here

- [Getting started](getting-started.md): create a notes service, call it over HTTP and MCP, test it and
  deploy it.
- [Concepts](concepts.md): the model behind every service, from a route file to the answer a caller
  receives, and the words the rest of the documentation uses.
- [Upgrading to 8.0](upgrading-to-8.md): move a 7.x service to the 8.0 project layout.

## Guides

Build the API:

- [Write code people and agents read easily](guides/writing-code.md): how a route, a handler, a name, a
  function and a comment are written in a Maximus project.
- [Project structure](guides/project-structure.md): the files and folders of a project, what each one
  declares, and what `maximus prepare` generates from them.
- [Routes](guides/routes.md): paths and methods, input from the path, query, body and headers,
  responses, byte bodies, attachments, limits, the OpenAPI document and the clients generated from it.
- [Schemas and validation](guides/schemas-and-validation.md): strict schemas, input codecs, query strings
  and reading data back from storage.
- [Errors and results](guides/errors-and-results.md): the error catalog, `fail`, declared failures and
  outcomes a caller cannot be sure of.
- [Authentication and scopes](guides/authentication-and-scopes.md): OAuth access tokens, the development
  token, scopes, actors, and tokens the application verifies itself.
- [Context and middleware](guides/middleware-and-context.md): what every handler receives, and code that
  runs around requests and operations.

Reach it:

- [MCP](guides/mcp.md): routes as tools, tools only agents call, instructions, guides and Agent Skills.
- [Worker RPC](guides/worker-rpc.md): typed calls between Workers of one account over Service Bindings.
- [Web apps](guides/web-apps.md): a React app served by the same Worker as its API.
- [Worker composition](guides/worker-composition.md): plain routes, webhooks, mounted APIs and a Worker
  composed by hand from the application builder.

Use the platform:

- [Bindings](guides/bindings.md): Workers KV, D1, R2, queues, Durable Objects, other Workers, Browser Run
  and secrets, declared once and typed in `Env`.
- [Background work](guides/background-work.md): scheduled handlers, queue consumers, email and work that
  outlives the response.
- [Durable Objects](guides/durable-objects.md): coordination and storage per key, with typed stubs.
- [Postgres transactions](guides/postgres.md): short tenant-scoped transactions with `pg`.

Ship it:

- [Testing](guides/testing.md): routes and MCP in Node, stand-ins for bindings, RPC types and end-to-end
  suites against a running Worker.
- [Observability](guides/observability.md): request ids, log events, observers, analytics and Cloudflare's
  logs and traces.
- [Deploying](guides/deploying.md): the origin, the token issuer, secrets, `cf deploy` and the CI workflow.
- [Lint and format](guides/lint-and-format.md): the presets every project uses and what they enforce.

## Reference

- [Configuration](reference/configuration.md): every option of `maximus()` in `vite.config.ts`.
- [Route and operation options](reference/operations.md): every field of a route's contract and of an
  operation definition.
- [CLI](reference/cli.md): `maximus` and `create-maximus`.
- [Wire formats](reference/wire-formats.md): response envelopes, headers, OpenAPI extensions, MCP and RPC.
- [Standard failures](reference/standard-failures.md): the failures every operation may answer.
- [Package exports](reference/exports.md): every entry of `@arbol-ai/maximus`.

## Design

- [Architecture](architecture.md): why Maximus is built the way it is, and the boundaries it keeps.

## Examples

[`examples/`](../examples) holds services that deploy to Cloudflare as they are: tasks with a web app,
notes in D1, two Workers over RPC, a queue with a dead letter queue, Browser Run, documents in R2 and a
Durable Object that books appointments. Each has tests in Node and an end-to-end suite.
