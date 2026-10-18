# The framework guide has moved

This single long page was split into task-oriented documentation. Start at the
[documentation index](README.md). Each former section now lives here:

| Former section | Now |
| --- | --- |
| Add an operation | [Concepts](concepts.md#operations), [Operation reference](reference/operations.md), [Authentication and scopes](guides/authentication-and-scopes.md) |
| MCP and OpenAPI | [MCP](guides/mcp.md), [HTTP and OpenAPI](guides/http-and-openapi.md#the-openapi-document) |
| Diagnostics and analytics | [Observability](guides/observability.md) |
| State and dependencies | [Architecture](architecture.md#state-and-side-effects), [Errors and results](guides/errors-and-results.md#uncertain-outcomes) |
| Testing and development | [Testing](guides/testing.md), [CLI reference](reference/cli.md) |
| Machine smoke and release | [Machine clients](guides/authentication-and-scopes.md#machine-clients), [Deploying](guides/deploying.md) |
| Fluent modules, middleware and clients | [Middleware and context](guides/middleware-and-context.md), [Typed client](guides/typed-client.md) |
| Organization credential middleware | [Organization credentials](guides/middleware-and-context.md#organization-credentials) |
| Exact route ownership and admission diagnostics | [Routing](guides/http-and-openapi.md#routing), [Worker composition](guides/worker-composition.md), [Native log events](guides/observability.md#native-log-events) |
| Several scopes, body limits and plain routes | [Scopes](guides/authentication-and-scopes.md#scopes), [Limits](guides/http-and-openapi.md#limits), [Plain routes](guides/worker-composition.md#plain-routes) |
| Mounted APIs, prefix protocols and static assets | [Worker composition](guides/worker-composition.md) |
| Validation ownership, canonical input codecs | [Schemas and validation](guides/schemas-and-validation.md) |
| Bounded client responses | [Typed client options](guides/typed-client.md#options) |
| Native files, assets and multiple OAuth resources | [Files](guides/http-and-openapi.md#files), [Static assets](guides/worker-composition.md#static-assets), [OAuth discovery](guides/authentication-and-scopes.md#oauth-discovery) |
| Classified publication | Removed: every operation declares its own HTTP route, MCP tool and RPC method. See the [changelog](../CHANGELOG.md) |
| Signed private admission, build artifacts | Removed in 5.0: see [Migrating to 5.0](guides/migrating-to-v5.md) |
