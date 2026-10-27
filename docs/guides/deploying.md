# Deploying

A project deploys as one Cloudflare Worker, with `cf`, Cloudflare's command line, through `bun run deploy`.
This guide covers what to set before the first deployment, the deployment itself, secrets, the resources a
deployment creates and those you create, the starter's GitHub workflow, and how to check the Worker once it
is deployed.

## Before the first deployment

### Choose the origin

`origin` in `maximus()` is the public HTTPS URL the Worker answers at. The OpenAPI document, MCP resources and
OAuth discovery advertise it, and access tokens must carry it as their audience unless `tokens.audience` says
otherwise. `maximus()` routes the Worker to it:

- A `workers.dev` origin, `https://notes.<subdomain>.workers.dev`: the Worker answers at its `workers.dev`
  URL (`workersDev: true`), with no custom domain.
- Any other origin, such as `https://notes.example.com`: its host becomes the Worker's custom domain
  (`domains: ['notes.example.com']`), and the `workers.dev` URL is off (`workersDev: false`).

The Worker's `workers.dev` URL is `https://<name>.<subdomain>.workers.dev`, where the name is `maximus()`'s
`name`, or else the package's name without its scope, and the subdomain is your account's. A custom domain
needs its zone in the same Cloudflare account; the deployment attaches the domain to the Worker.

When the options route the Worker themselves, with `domains` or a fetch trigger
(`triggers.fetch({ pattern: 'example.com/notes/*' })`), `maximus()` adds no domain. `workersDev` and
`previewUrls` in the options win over what `maximus()` sets; preview URLs are off unless you turn them on.

### Name the token issuer

`tokens.issuer` is the OAuth authorization server whose access tokens the deployed Worker accepts.
[Authentication and scopes](authentication-and-scopes.md) describes the tokens it accepts and the claims it
reads. A deployed Worker accepts no development token: only a build `vp dev`
runs declares its binding and the policy that accepts it.

### Sign in to Cloudflare

```sh
bunx cf auth login
```

`cf auth login` signs your machine in to your account once. A CI job signs in with the environment variables
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` instead.

## Deploy

```sh
bun run deploy
```

`bun run deploy` runs `bun run verify` and then `cf deploy --prebuilt --mode production`. `verify` checks the
types, lint and format, runs the tests and builds: `vp build` writes the Worker and its configuration to
`.cloudflare/output/`. `cf deploy --prebuilt` uploads that build as it is, without building again, and
makes it the Worker's deployed version.

Before you deploy, look at what would be deployed:

- `bun run preview` serves the production build locally, in workerd. Like a deployment, it accepts no
  development token.
- `bunx cf deploy --prebuilt --mode production --dry-run` checks the build in `.cloudflare/output/` and lists
  the bindings the Worker would receive, without uploading anything:

  ```text
  ├  Deploy
  |  Total Upload: 472.98 KiB / gzip: 127.61 KiB
  |  Your Worker has access to the following bindings:
  |  Binding                   Resource
  |  env.NOTES                 KV Namespace
  |  env.NOTES_DB (notes)      D1 Database
  |
  |  --dry-run: exiting now.
  ```

Options after `bun run deploy` go to `cf deploy`. `--tag` and `--message` record what a version is, such as
the commit it was built from:

```sh
bun run deploy --tag "$(git rev-parse --short HEAD)"
```

## Secrets

Declare each secret the Worker reads as a binding, so the generated `Env` types it:

```ts
env: { NOTES: bindings.kv(), PARTNER_API_KEY: bindings.secret() },
```

Under `vp dev`, its value comes from `.dev.vars`, beside the development token, one `NAME=value` line each.

A deployment needs each declared secret to have a value:

- **The first deployment supplies every one**, in a file outside the repository, as `NAME=value` lines or a
  JSON object. A Worker that does not exist yet cannot receive a secret in advance, and a first deployment
  without one stops with `The following required secrets have not been set`.

  ```sh
  bun run deploy --secrets-file .env.production
  ```

- **Later deployments keep each secret's value** unless their secrets file brings a new one. To change one,
  deploy with a file that holds its new value. `bunx cf workers secrets update` sets one secret alone: it
  takes the Worker with `--worker` and the value with `--text`, and creates a new version of the Worker with
  that secret.

The starter's `.gitignore` ignores `.env*` and `.dev.vars*`. A secret never goes in a `bindings.text()`
value, in code or in the repository. A secret several Workers share can live in Secrets Store instead: bind it
with `bindings.secretsStoreSecret({ storeId, secretName })` and read it with `await env.NAME.get()`.

The development token is no secret of the deployed Worker. `maximus()` refuses a `DEVELOPMENT_TOKEN` binding
in `env`:

```text
DEVELOPMENT_TOKEN is the development token: Maximus declares it under vp dev alone, so no deployed Worker carries it.
```

## Resources

### What a deployment creates

`cf deploy` creates the resources of the Worker's bindings that need them, as it deploys:

- a KV namespace declared without an id, `bindings.kv()`;
- an R2 bucket or a queue, by the name its binding gives;
- the consumer trigger of each queue module, the cron trigger of each schedule a cron module states, and the
  triggers the options declare;
- the storage of each Durable Object class the options export, such as
  `exports: { NoteCounter: exports.durableObject({ storage: 'sqlite' }) }`;
- the custom domain of an origin outside `workers.dev`.

It does not write the ids it creates into `vite.config.ts`. The examples' READMEs say what each first
deployment creates; a queue's dead letter queue, for instance, appears when the first message moves to it.

A Durable Object class's name is its storage's: renaming or removing an exported class is a migration you
declare in `exports`, never a rename in code alone. See [Durable Objects](durable-objects.md).

### What you create yourself

A D1 database is yours to create, because its tables come from migrations you apply before the Worker that
reads them is deployed:

```sh
bunx cf d1 create --name notes              # prints the database's id
bunx cf d1 migrations apply <database-id>   # applies migrations/*.sql that are not applied yet
```

`cf d1 migrations apply` reads `migrations/*.sql` in order and records each file it applied in the database's
`d1_migrations` table, so running it again applies only new files. The binding names the database by its id:

```ts
// vite.config.ts
import { maximus } from '@arbol-ai/maximus/vite';
import { bindings } from 'cf/config';
import { defineConfig } from 'vite-plus';

/** The id of the local database, which no Cloudflare account holds: a build bound to it never deploys. */
const LOCAL_DATABASE = '00000000-0000-4000-8000-00000000d1d1';

export default defineConfig({
  plugins: [
    maximus({
      origin: 'https://notes.example.com',
      tokens: { issuer: 'https://auth.example.com/' },
      compatibilityDate: '2026-10-27',
      env: { NOTES_DB: bindings.d1({ name: 'notes', id: process.env.NOTES_DB_ID ?? LOCAL_DATABASE }) },
    }),
  ],
});
```

[`examples/d1-notes`](../../examples/d1-notes) reads the id from `NOTES_DB_ID` when it builds, so one
configuration builds for any account, and migrates its local database, which `vp dev` keeps in
`.cloudflare/state/`, with `cf d1 migrations apply <local id> --local --persist-to .cloudflare/state`.

Deploy in that order: apply the migrations, then deploy the Worker. The version running until the new one
is deployed meets the migrated schema, so a migration keeps what that version reads.

A Worker this one binds over a Service Binding must exist before this one deploys: deploy it first, as
[`examples/worker-rpc`](../../examples/worker-rpc) deploys pricing before orders.

## The GitHub workflow

The starter's `.github/workflows/ci.yml`, named Verify and deploy, runs on every pull request, on every push
to `main` and on demand:

1. It checks the repository out without keeping the job's token, sets up Bun and Node.js, and installs the
   dependencies from the lockfile without running their install scripts.
2. It runs `bun run verify`: types, lint and format, tests and the build.
3. It runs `bunx cf deploy --prebuilt --mode production --dry-run`, which needs no Cloudflare credentials.
4. On a push to `main`, and only there, it deploys the build:
   `bunx cf deploy --prebuilt --mode production`.

The deploy step alone receives the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`;
add them in the repository's settings before the first push to `main`. The job's own token can only read
the repository, its actions are pinned to commits, and runs of one branch wait for each other rather than
cancel a deployment in progress.

The workflow passes no secrets file: make the first deployment of a Worker with secrets from your machine,
with `bun run deploy --secrets-file …`. The deployments the workflow makes after it keep them.

## Check the deployment

A suite that passed over stand-ins says nothing about the deployed Worker: check the Worker itself.

```sh
curl https://notes.example.com/health
```

```json
{ "status": "ok", "service": "notes", "version": "0.1.0" }
```

1. `/health` answers `200` with the service's name and the version you deployed: `maximus()`'s `version`, or
   else the package's.
2. `/api/openapi.json` lists the operations you expect. `verifyContract` from `@arbol-ai/maximus/testing`,
   given `fetch` and `https://notes.example.com/api`, also checks that the YAML document is the same document
   (see [Testing](testing.md#check-the-published-contract)).
3. A route called without a token answers `401` with a challenge that names the service's OAuth metadata:

   ```text
   www-authenticate: Bearer resource_metadata="https://notes.example.com/api/.well-known/oauth-protected-resource"
   ```

   That document names your issuer in `authorization_servers`, and an OAuth client reads it to find where to
   obtain a token.

4. `/mcp`, when the service serves MCP, answers `401` to a client without a token.
5. A call with a real access token for a test organization succeeds. The development token is refused.
6. An operation served over RPC answers a real calling Worker, deployed with its binding.

The suite in [Testing](testing.md#run-suites-against-a-running-worker) runs the first three checks:
`WORKER_URL=https://notes.example.com bun run test running`. Keep the access tokens and raw responses of
these checks out of the repository and out of shared logs; the starter's `.gitignore` ignores `.private/`
for them.

A staging Worker is a deployment of its own: give it its own name and origin, its own resources and an
audience its tokens are issued for, so a token for staging is never valid in production and a test never
writes to production data.
