# CLI reference

`@arbol-ai/maximus` installs one command-line tool, `maximus`, with one command, `init`. It never
belongs in a Worker bundle. Developing, building and deploying a service are `cf`'s own commands,
which Maximus does not wrap: `cf dev`, `cf build`, `cf workers types` and `cf deploy` (see
[Deploying](../guides/deploying.md)).

Run it without installing anything, or as `maximus init` from a project that depends on
`@arbol-ai/maximus`. Never run `bunx maximus` or `npx maximus`: they download the unrelated public npm
package named `maximus`. `--help` prints the usage.

## maximus init

```sh
bunx @arbol-ai/maximus init <new-directory> --name <name>
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

