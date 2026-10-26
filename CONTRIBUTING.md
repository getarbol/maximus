# Contributing to Maximus

Thank you for helping. This guide covers setting up the workspace, the checks every change passes,
the rules the framework keeps, and how to propose a change.

## Set up

You need [Bun](https://bun.sh) 1.4 and Node.js 22.18 or later (Vite+ runs library packing on Node, and
the release checks run `node` and `npm`).

```sh
bun install --frozen-lockfile
bun run build
```

| Path                      | Contains                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/maximus/`       | The published package: the core at the root of `src/`, one folder per entry (`workers/`, `mcp/`, `client/`, …); `tests/` mirrors it.                                                                    |
| `examples/*`              | Runnable example services. They are workspace packages, so they typecheck with everything else.                                                                                                         |
| `docs/`                   | The documentation.                                                                                                                                                                                      |
| `.agents/skills/maximus/` | The canonical Agent Skill. `.claude/skills` and `.codex/skills` link to it; `bun run build` copies it into `packages/maximus/skills/` and the LICENSE beside it; both copies are generated and ignored. |
| `scripts/`                | Build, verification and publication scripts.                                                                                                                                                            |

### Where the code lives

Read a call top-down: `builder.ts` declares, `define-app.ts` checks, a transport admits, and
`execution.ts` runs. In `packages/maximus/src/`:

| Concern                  | Modules                                                                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Declaring an application | `builder.ts` (the fluent builder), `manifest.ts` (what an application and an operation are), `define-app.ts` (every rule `.build()` checks)                                                                          |
| Running an operation     | `execution.ts` (eligibility, input decoding, context, middleware, handler, output checks)                                                                                                                            |
| HTTP                     | `http.ts` (the handler), `internal/http-layout.ts` (who owns which path), `internal/http-query.ts` (typed GET queries), `http-paths.ts` (the router), `binary.ts` and `attachment-schema.ts` (byte bodies and files) |
| Contracts                | `openapi.ts` (the OpenAPI document), `schema-bundle.ts` (named schemas as components)                                                                                                                                |
| Schemas                  | `schemas.ts` (the browser entry), `input-schemas.ts` (codecs), `validation.ts`, `schema-reader.ts`, `common-schemas.ts`, `pagination.ts`                                                                             |
| Identity                 | `tokens.ts` (verification and the principal), `scopes.ts`, `oauth.ts` (RFC 9728 metadata)                                                                                                                            |
| Failures                 | `result.ts`, `errors.ts` (catalogs), `standard-failures.ts`                                                                                                                                                          |
| Observability            | `telemetry.ts` (diagnostics and observers), `internal/diagnostics.ts` (safe error descriptions), `internal/correlation.ts`                                                                                           |
| Entries                  | `workers/`, `mcp/`, `client/`, `analytics/` and `tooling/` (the CLI and `/testing`) depend on the core, never the other way round; `postgres/` depends only on `pg`                                                  |

Files under `internal/` are shared helpers; entries re-export the few that are public (the body
readers, `createDiagnostics` and the correlation helpers).

## Check your change

| Command                 | Runs                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `bun run typecheck`     | TypeScript in every package and example, as Vite+ tasks.                                       |
| `bun run check`         | Vite+ lint (Oxlint) and format (Oxfmt) with the Maximus presets. `bun run fix` fixes.          |
| `bun run test`          | The `unit` and `examples` test projects of the root `vite.config.ts`.                          |
| `bun run test:coverage` | The `unit` project with V8 coverage; under 90% lines, branches, functions or statements fails. |
| `bun run verify`        | Vite+ library and Worker builds, workspace TypeScript, lint and formatting.                    |
| `bun run verify:tests`  | Explicitly requested test suites and packed-package smoke checks.                              |

Run `bun run verify` before you open a pull request. Tests require a human request; CI runs the same on every push and pull
request, and the publish workflow runs it before it publishes. The Postgres entry also has
integration tests,
`bun run test:integration` (the `postgres` test project), which need Docker and an already installed
`postgres:18.6-trixie` image.

## Rules the framework keeps

These are the design constraints reviewers check. The [architecture](docs/architecture.md) explains
why.

- Native Web `fetch` routing, TypeBox and TypeScript. No Elysia, Hono, Zod or runtime code
  generation.
- The root and core entries import no MCP, Postgres or Workers runtime code.
  Optional entries depend toward the core, and provider SDKs live only in their entry. Runtime entry points never
  import a CLI, environment variables, templates or file-system code.
- Each check has one owner: authentication, input validation, middleware, execution and output
  validation happen once, in the shared execution path. Never replace a check with a cast or a trust
  flag.
- Middleware cannot bypass authentication; annotations and visibility never authorize.
- Diagnostics carry no request or response bodies, credentials, cookies or error text, and never an
  invented trace id.
- Failures never become successful empty data.
- Readability comes before deduplication: keep named functions and clear folders rather than
  indirect registries.
- Defaults, fixtures, tests and documentation contain no customer data, credentials, private
  evidence, production domains or operator identities. Use `example.com`, `example.test` and
  identifiers such as `org_1234567890abcdef`.

## Tests

Tests live beside the entry that owns the behavior (`packages/maximus/tests/<entry>/`). Keep the existing security, privacy and retry
tests, and add negative type controls (`@ts-expect-error`) when you change inferred types. A test
uses synthetic data only and never calls a live provider or a paid service.

## Documentation, examples and the skill

- Code, comments and documentation are in English.
- Each module, test and script opens with a comment saying what it owns or covers. In the package's
  `src/` and in the examples, each declaration, exported or not, has a doc comment saying what it is.
  A comment inside a function says why, never what the next line does.
- A change in behavior updates the guide or reference page that describes it in the same pull
  request. Prose in `docs/` is not formatted automatically; keep lines near 100 characters.
- Examples must keep running with `cf dev`, building with `cf build` and typechecking with the
  workspace.
- Edit the skill only in `.agents/skills/maximus/`, never the generated copy.

## Commits

Write the subject in the imperative, saying what changes for users (for example, "Let an explicit
route live beneath a transport's path"), without a type prefix. Use the body to explain why, and what
a consumer must do, if anything. Keep one logical change per commit.

## Propose a change

1. For a new capability or a breaking change, open an issue first and describe the problem it
   solves.
2. Open a pull request with the change, its tests and its documentation. Add a line under
   **Unreleased** in [CHANGELOG.md](CHANGELOG.md) when the change is visible to users.
3. Report security problems privately, as described in [SECURITY.md](SECURITY.md), never in an issue
   or pull request.

## Releases

Maintainers release by merging a version change to `main`: the **Publish Maximus** workflow runs on
every push to `main` and publishes when npm does not have the package version yet (it can also be
started by hand). Maximus is one package,
`@arbol-ai/maximus` on npm; a breaking change moves the major version. It is published from its
packed tarball with npm provenance, never with `workspace:` or `file:` dependencies, and published
versions never change. Installing from the registry and verifying a real deployment are separate
gates after publication.

## License

Maximus is released under the [MIT License](LICENSE). By contributing, you agree that your
contributions are licensed under the same terms.
