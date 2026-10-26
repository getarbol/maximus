# Migrating to 4.0

Maximus 4.0 is one package. Every former `@getarbol/maximus-*` package is now an entry of
`@getarbol/maximus`, with the same exports. Maximus 5.0 then removed the delegated entrypoint, the
`/delegation` and `/admitted` entries, `contract` and `maximus publish`, `export` and `permissions`;
see [Migrating to 5.0](migrating-to-v5.md).

## Dependencies

Keep only `@getarbol/maximus` and remove the others. The `maximus` command
comes with it, so `@getarbol/maximus-tooling` leaves your development dependencies too.

```sh
bun remove @getarbol/maximus-workers @getarbol/maximus-mcp @getarbol/maximus-client \
  @getarbol/maximus-tooling
bun add @getarbol/maximus@4
```

`pg` (for `/postgres`) and `oxlint`, `oxfmt` or `ultracite` (for the presets) are optional peer
dependencies: add the ones you use.

## Imports

| 3.x                                                   | 4.0                                  |
| ----------------------------------------------------- | ------------------------------------ |
| `@getarbol/maximus-workers`                           | `@getarbol/maximus/workers`          |
| `@getarbol/maximus-mcp`                               | `@getarbol/maximus/mcp`              |
| `@getarbol/maximus-client`                            | `@getarbol/maximus/client`           |
| `@getarbol/maximus-analytics`                         | `@getarbol/maximus/analytics`        |
| `@getarbol/maximus-tooling` (`verifyContract`)        | `@getarbol/maximus/testing`          |
| `@getarbol/maximus-tooling/oxlint`, `/oxfmt`          | `@getarbol/maximus/oxlint`, `/oxfmt` |
| `@getarbol/maximus-postgres/transaction`, `/failures` | `@getarbol/maximus/postgres`         |

The root and its existing entries (`/schemas`, `/errors`, `/delegation`, `/body`, …) are unchanged.

## Removed

- `createWorker`'s `adapters` option and the `RuntimeAdapter` and `RuntimeApplication` types; see
  [Observability](observability.md) for Cloudflare's logs and traces.
- The `maximus token` command and its `--url`, `--issuer`, `--organization`, `--output` and
  `--scope` flags.

## The CLI

The CLI finds the Worker by its `cloudflare.config.ts` or Wrangler file and reads the application,
the web app and the Gateway entrypoint from the Worker's module, so most flags go:

| 3.x                                                            | 4.0                                                                           |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `maximus check --app src/app.ts#app --wrangler wrangler.jsonc` | `maximus check`, in the Worker's directory or at the workspace's root         |
| `--wrangler <path>`                                            | Run in that Worker's directory, or name it: `maximus check api`               |
| `--worker <name>` (export, publish)                            | The name the Worker's configuration gives                                     |
| `--entrypoint <Class>`                                         | Export `worker.delegatedEntrypoint` under that name; the flag still overrides |
| `publish --package … --notify …`                               | `contract: { package, notify }` in the application; the flags still override  |

`--app` remains, to read another application than the one `createWorker` was given.

## The Agent Skill

The skill now ships at `node_modules/@getarbol/maximus/skills/maximus/SKILL.md`; update any project
guide that points at the tooling package's copy.
