# Maximus documentation

## Start here

- [Getting started](getting-started.md): build, run and call a service in fifteen minutes.
- [Concepts](concepts.md): the model, the request lifecycle and the vocabulary every page uses.

## Guides

Build a service:

- [HTTP and OpenAPI](guides/http-and-openapi.md): routes, input, responses, limits, files and the
  runtime contract.
- [Schemas and validation](guides/schemas-and-validation.md): strict schemas, input codecs, query
  strings, lists and reading untrusted data.
- [Errors and results](guides/errors-and-results.md): the error catalog, failures on every transport
  and uncertain outcomes.
- [Middleware and context](guides/middleware-and-context.md): `derive`, `use`, `mount` and resource
  modules.
- [Authentication and scopes](guides/authentication-and-scopes.md): OAuth verification, custom
  resolvers, scopes and discovery.

Reach it:

- [MCP](guides/mcp.md): the same operations as MCP tools, with guides and Agent Skills.
- [Worker RPC](guides/worker-rpc.md): typed calls between Workers over Service Bindings.
- [Typed client](guides/typed-client.md): call a service from TypeScript.
- [Worker composition](guides/worker-composition.md): webhooks, mounts, hooks, static assets and
  entrypoints.

Run it:

- [Observability](guides/observability.md): request ids, log events, observers, analytics, and
  Cloudflare's logs and traces.
- [Postgres transactions](guides/postgres.md): short tenant-scoped transactions with `pg`.
- [Testing](guides/testing.md): fast handler tests, MCP, RPC types and contract smoke tests.
- [Lint and format](guides/lint-and-format.md): the presets and the guardrails they enforce.
- [Deploying](guides/deploying.md): configuration, secrets and verifying a deployment.

Upgrade it:

- [Migrating to 5.0](guides/migrating-to-v5.md): the delegated entrypoint, admission and the service
  artifact are gone.
- [Migrating to 4.0](guides/migrating-to-v4.md): one package, entries instead of packages.
- [Migrating from 2.x](guides/migrating-from-v2.md).

## Reference

- [Configuration](reference/configuration.md): every option of `maximus()`, `createWorker()` and the
  optional packages.
- [Operations](reference/operations.md): every field of an operation definition.
- [CLI](reference/cli.md): `maximus`.
- [Wire formats](reference/wire-formats.md): envelopes, headers, OpenAPI extensions, MCP and RPC.
- [Standard failures](reference/standard-failures.md).
- [Package exports](reference/exports.md).

## Design

- [Architecture](architecture.md): why Maximus is built the way it is.

## Examples

Runnable services in [`examples/`](../examples): a minimal HTTP service, HTTP and MCP from the same
operations, and two Workers over native RPC.
