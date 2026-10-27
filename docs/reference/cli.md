# CLI reference

`@arbol-ai/maximus` installs one command-line tool, `maximus`, with `init` and `prepare`. It never
belongs in a Worker bundle. Vite+ develops and builds a service (`vp dev`, `vp build`), and
Cloudflare's `cf` generates its types and deploys it (`cf workers types`, `cf deploy`); Maximus wraps
neither (see [Deploying](../guides/deploying.md)).

Run it without installing anything, or as `maximus init` from a project that depends on
`@arbol-ai/maximus`. Never run `bunx maximus` or `npx maximus`: they download the unrelated public npm
package named `maximus`. `--help` prints the usage.

## maximus init

```sh
bunx @arbol-ai/maximus init <new-directory> --name <name> [--layout service|project]
```

Creates a starter project from the package's templates: one Worker with an empty application, its
`cloudflare.config.ts` and `vite.config.ts` for `cf`, the shared Oxlint and Oxfmt configuration, a
contract smoke test that runs in workerd, agent guidance and a CI workflow. Its scripts are `cf`'s
(`dev`, `build`, `deploy`), and `.dev.vars` holds a random development token that its
`cloudflare.config.ts` declares for `cf dev` alone.
The project depends on the same Maximus release as the CLI that created it. `--name` is a
kebab-case name of 2 to 41 characters (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`); it names the package, the
Worker, the scope namespace and the entrypoint (`demo-notes` exports `DemoNotesService`). It never
overwrites an existing directory and provisions nothing. Before the first deployment, replace the
placeholder origin, audience and issuer in `src/app.ts`; a fresh project passes `bun run verify` as
generated.

`--layout project` creates the optional [project structure](../guides/project-structure.md): a public
Hello World page, a protected greeting operation, generated imports and a deployment workflow. Its
non-test `verify` checks types, lint and build. `vite.config.ts` is its only configuration: configure
origin, authentication and bindings in its `maximus()`; `src/` is optional and the Worker entry is generated.

## maximus prepare

```sh
maximus prepare [directory] [--mode production|development]
```

Discover project modules and write `.maximus/base.ts`, `.maximus/routes.ts`, `.maximus/register.d.ts`,
`.maximus/app.ts`, `.maximus/middleware.ts`, `.maximus/worker.ts` and the stable `.maximus/entry.ts`, and for
a project configured in `vite.config.ts`, `.maximus/config.ts` and `.maximus/env.d.ts`. Suffixed route
files, 7.4 method exports and legacy factories are supported. The default directory is the current
directory, and the default mode is production. A project without `maximus.config.ts` or `src/` entries
is prepared through the plugin its `vite.config.ts` configures: Vite loads that file, as every `vp`
command does. `maximus()` from `@arbol-ai/vite-plugin` invokes the same generator on every build and
watches additions, removals and changed exports. Discovery reads application modules' syntax without
executing them.
