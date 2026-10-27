# Maximus agent guide

Maximus is @arbol-ai/maximus and its Vite plugin @arbol-ai/vite-plugin, released together at one
version, in a Bun/Vite+ workspace with its examples. The core is @arbol-ai/maximus's root; each optional
capability is an entry (/workers, /mcp, /client, …) whose source is packages/maximus/src/<entry>/. The
plugin, packages/vite-plugin/, composes the project tooling with Cloudflare's Vite plugin. Read
docs/README.md (concepts, guides, reference) and the owned .agents/skills/maximus/SKILL.md; examples/
holds runnable services that the workspace typechecks.
All code and documentation is English. Use CLI/scripts and preserve unrelated changes.

Use native Web fetch routing, TypeBox and TypeScript 7. No Elysia, Eden, Hono, Zod or runtime code
compilation. The root and core entries never import an optional entry (workers, mcp, postgres,
tooling). Optional entries depend toward the core. Provider SDKs live only in their entry. Runtime
entrypoints never import a CLI, process environment, templates or filesystem code.

The fluent builder infers context once; modules share a base and declare each operation once.
HTTP, MCP and RPC exposures are explicit. Namespaced scopes and organizationId are canonical.
Authentication, input checks, middleware, execution and output/error checks have a single owner.
Services are reached over HTTP with the caller's token and over native RPC. Preserve
ordinary PrincipalSchema/RPC props. Verified Invocation.authority retains client/surface/scopes;
conditional operations fail closed when it is absent. Owners enforce client/environment and tenant
activity and resource policy. The Postgres entry is independent of the core and does not
install RLS: tenant predicates and composite keys belong to product repositories.
Middleware cannot bypass authentication; annotations are not authorization. Custom token verification
belongs to the application's tokens.resolve, with cryptographic validation and strict principal parsing.

Framework code contains no control-panel database, credential ownership or customer policy.
Each provider owns its credentials and sessions. Native caller props are strict and operation-specific. Preserve DO names/state.
Human and machine OAuth remain owned by the identity provider; the framework owns no credential
database or permission lists. No public provider-login/password tool. Failures never become successful empty data.

Observers are optional and independently isolated. Only safe execution metadata reaches analytics.
No raw input/output, credentials, cookies or clinical data. Providers sanitize error events; disabling
framework telemetry and disabling native platform collection are separate controls. Never invent trace IDs.

Tests live beside their entry, in packages/<package>/tests/<entry>/. Preserve security/privacy/retry tests; add negative type controls.
Run bun run verify (Vite+ builds, workspace TypeScript, lint and format) and production dry bundles
before release. Tests require an explicit human request, including scripts, hooks and CI. Publish the packed tarball. Never publish workspace: or file: dependencies.
Registry installation and actual production verification are separate gates; never label mocks live.

Canonical skills are tracked in .agents/skills with harness symlinks; the package includes a generated copy
at package time. Do not edit generated skill copies. Raw provider evidence remains in ignored .private/
with 0700 directories and 0600 files. Never copy customer fixtures or credentials into this framework.
Commit only when authorized, with the configured git identity, no git config changes or
assistant attribution. Package licensing and public visibility require a deliberate separate decision.

## Readability before deduplication

Folder readability and visible domain ownership take priority over removing a few repeated lines.
Preserve named resource functions and the existing separation between operations, schemas and
provider protocol. Extract repeated infrastructure only when it makes the consuming code easier
to read. Do not replace clear folders with inline method registries, indirect factories or a
large context object merely to reduce line count.

Validation ownership: executeOperation checks business input and output/error once across HTTP/MCP/RPC.
The SDK owns MCP envelopes only. Typed internal helpers must not re-parse those arguments or results.
Keep checks at independently callable RPC entries, provider and persistence readers. Forward an unchanged
same-owner DO result to the shared output boundary; do not validate it twice. Internal calls behind a
validating method use a typed private implementation. Never replace checks with casts or trust flags.
