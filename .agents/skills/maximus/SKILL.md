---
name: maximus
description: Build, extend, test, migrate and release services with the Maximus framework (@arbol-ai/maximus*), which declares schema-first, organization-scoped operations once and serves them over HTTP/OpenAPI, MCP and Cloudflare Worker RPC. Use when code imports @arbol-ai/maximus or a task involves Maximus operations, scopes, error catalogs, derive/use middleware, MCP tools, RPC entrypoints, OpenAPI documents or the maximus CLI.
---

# Maximus

Maximus services declare each operation once (schemas, scope, effect, exposure, handler) on one
fluent application. Each transport admits the caller its own way, then every call runs the same
pipeline: input decoding, preparation, middleware, handler, output validation. Work with that
pipeline, never around it.

## Workflow

1. **Read the service first.** Find `maximus<Env>(…)` (usually `src/application.ts`), the resource
   modules (`src/api/<resource>/operations.ts`), the composition (`src/app.ts`) and the Worker
   (`src/index.ts`). Keep the project's existing folders and named domain functions.
2. **Declare, don't wire.** Add an operation to its resource module with strict schemas, a namespaced
   scope, a truthful effect and only the transports it needs (`http`, `mcp`, `rpc`). Mount new
   modules in `app.ts`. See `references/adding-an-operation.md`.
3. **Return Results.** Expected failures are `err(catalog.x.create())` from the application's own
   catalog; throw only for the unexpected. See `references/errors-and-results.md`.
4. **Prepare context with `.derive()`** in the group that needs it, and wrap with `.use()` only for
   cross-cutting behavior after authorization.
5. **Verify** with the project's typecheck, lint and tests, then `cf build` and a dry-run deploy
   (`cf deploy --prebuilt --mode production --dry-run`). See `references/testing.md` and
   `references/publishing-and-verification.md`.

## Decisions

| Question | Choose |
| --- | --- |
| Who calls it? People or external services over the network | `http` (and `mcp` for agents) with OAuth tokens |
| Another Worker in the same account, trusted deployment | `rpc` with `rpc.callers`; see `references/transports.md` |
| Documents that list only the failures it can answer | `failures` (its domain codes); any other becomes `INTERNAL_ERROR`; see `references/adding-an-operation.md` |
| A gateway in front of the service, forwarding each caller's own token | Nothing special: list its audience in `tokens.audience` after the service's own; it calls the origin's own routes |
| Staff operations hidden from documents and clients | `visibility: 'internal'`: still routed and decided by scope on the origin |
| Verifying a provider webhook | `@arbol-ai/maximus/webhooks` on the raw body, in a plain route |
| Callers without bearer tokens (webhooks, signed links) | A plain route that verifies its own signature |
| Tokens that are not organization-bound OAuth access tokens | `tokens.resolve`, verifying cryptographically |
| SDKs or a catalog generated from the contract | The origin's `/openapi.json`, or `createOpenApi(app)` at build time; see `references/transports.md` |
| A new service from scratch | `references/building-a-service.md` |
| Upgrading from 4.x | `references/migration-to-v5.md` |
| Upgrading from 2.x | `references/migration-from-v2.md` |

## Rules that are never broken

- **Tenancy:** every tenant query uses `context.principal.organizationId`. Never take an
  organization from input, a header or a path.
- **Strict schemas:** inputs and outputs are `t.Object({...}, { additionalProperties: false })` or
  unions of such objects; a GET input is one object, each field read from the query string as its
  kind (integer, number, boolean, comma-separated string list, otherwise string).
- **Validation ownership:** the framework validates operation input and output once. Do not re-parse
  inputs in handlers or helpers; do validate provider responses, stored records and model output with
  `checkSchema`/`readSchema`. No casts, trust flags or no-op validators.
- **Codecs need `inputSchema()`:** an input using `normalizeSchema`, `refineSchema`,
  `transformSchema`, `inspectSchema`, `pipeSchema` or `stripObject` must be wrapped in
  `inputSchema(...)`; `.build()` refuses it otherwise, because a plain decode would skip the codecs.
- **Authorization is scopes plus your checks:** effects, `visibility: 'internal'`, descriptions and
  MCP annotations never authorize. Ordinary RPC checks no scopes.
- **Failures are honest:** an outage is a failure, never an empty success. A write whose outcome is
  lost answers `OUTCOME_UNKNOWN` and is reconciled, never retried blindly.
- **Outbound calls:** in a Worker, `fetch(..., { redirect: 'error' })` throws before any request
  (only `follow` and `manual` exist). Send credentials with `redirect: 'manual'` and refuse a `3xx`.
- **Privacy:** never log or return request bodies, credentials or submitted values in failure
  `data`, refinement messages, MCP skills or examples. Skills and guides hold no tenant data.
- **Collections are pages:** an operation that returns many items answers `Page(Item, { $id })` with
  `PageQueryFields`; one that reads, creates or updates an item answers the named entity (the list's
  item); a delete answers `DeletedObjectSchema`. Use the shared schemas (`UuidSchema`,
  `EmailAddressSchema`, …) instead of local copies.
- **Construction errors are guidance:** `.build()` throws a `TypeError` stating the rule (usually with
  the operation's name); fix the definition rather than loosening checks.

## References

Load the one that matches the task:

- `references/building-a-service.md`: project layout, configuration, tokens, Worker, local run.
- `references/adding-an-operation.md`: every definition field, routes, schemas, codecs, middleware.
- `references/transports.md`: HTTP and OpenAPI, MCP, native RPC, plain routes and Worker composition.
- `references/errors-and-results.md`: catalogs, standard failures, presentation, uncertain outcomes.
- `references/testing.md`: handler tests, the `verify` seam, MCP, `executeOperation`, RPC types.
- `references/migration-to-v5.md`: what 5.0 removed and what to change.
- `references/migration-from-v2.md`: 3.0.0 breaking changes and classifying older services.
- `references/publishing-and-verification.md`: `maximus init`, deploying, verifying a deployment and
  releasing Maximus itself.

The full documentation is in the Maximus repository under `docs/`; this skill ships in
`@arbol-ai/maximus` at `skills/maximus/`.
