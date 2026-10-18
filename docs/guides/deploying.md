# Deploying

A Maximus service deploys like any Worker, with Cloudflare's [`cf`](https://developers.cloudflare.com/cf/)
CLI: `cf build` writes the Build Output and `cf deploy --prebuilt` deploys that same build. This guide
lists what to configure, what to check before deploying and how to verify the deployed Worker.

## Configure the Worker

`cloudflare.config.ts`:

```ts
import { bindings, defineConfig } from 'cf/config';

import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

export default defineConfig(({ mode }) => ({
  worker: {
    name: 'notes',
    compatibilityDate: '2026-10-12',
    compatibilityFlags: ['nodejs_compat'],
    entrypoint,
    domains: ['notes.example.com'],
    workersDev: false,
    previewUrls: false,
    observability: { enabled: true, logs: { invocationLogs: true }, traces: { enabled: true } },
    env: {
      NOTES: bindings.kv({ id: '<namespace id>' }),
      // Declared for `cf dev` alone: no deployed build carries the development token.
      DEVELOPMENT_TOKEN: mode === 'development' && bindings.secret(),
    },
  },
}));
```

- `nodejs_compat` is required: Maximus keeps per-request diagnostics in `node:async_hooks`.
- The application's `origin` must be the public HTTPS URL callers use; OpenAPI, MCP resources and
  OAuth discovery advertise it.
- `tokens.issuer` and `tokens.audience` must match what your authorization server issues for this
  deployment.
- Decide `workersDev` and `previewUrls` deliberately: a `workers.dev` URL is another origin for the
  same Worker. `http.origins` refuses origins you did not list.
- A binding without an id, such as `bindings.kv()`, is provisioned by `cf deploy`, which does not
  write the new id back to `cloudflare.config.ts`.
- Keep Durable Object class names stable, and declare each one as an export
  (`exports.durableObject({ storage: 'sqlite' })`). Renaming a class orphans its state.

## Secrets

- Declare each secret the Worker reads as `bindings.secret()` and upload its value with a version,
  `cf deploy --secrets-file <path>` (JSON or `.env`), or keep it in a Secrets Store binding. Never put
  it in a `bindings.text()` value, in code or in a repository. `cf` cannot set a single secret yet; until
  it can, `npx wrangler secret put <NAME>` does.
- `.dev.vars` is read only by `cf dev`; keep it out of version control.
- Public material, such as a pinned public verification key, may live in a `bindings.text()` value.
- Never set a development token or test credential on a deployed Worker.

## Check before deploying

```sh
bun run typecheck                 # cf build does not typecheck
bun run test
cf build                          # writes .cloudflare/output/v0/, uploads nothing
cf workers check --prebuilt --mode production   # profiles the Worker's startup
cf deploy --prebuilt --mode production --dry-run
```

`cf deploy --prebuilt` must be given the mode the build recorded: `production` for a Vite build
without `--mode` (`buildContext.mode` in `.cloudflare/output/v0/config.json`). Look in that Build
Output too: `workers/default/worker.config.json` lists the bindings the deployment gets, and the
development token must not be among them. A project made by `maximus init` chains the checks as
`bun run verify`, and `bun run deploy` deploys the build `verify` made:

```sh
cf auth login                     # once, or set CLOUDFLARE_API_TOKEN in CI
bun run deploy                    # verify, then cf deploy --prebuilt --mode production
```

Deploy from a clean, pushed commit. `cf deploy --tag <tag> --message <text>` records what a version
is, for example the commit's id and subject, so `cf workers versions list` names exactly what runs.

Look at the dry-run bundle after changing composition. Configuration, CLI and testing code must not
reach the Worker; Maximus packages are side-effect free, so importing only what you use keeps them
out. Package size and bundle size are separate budgets.

## Verify the deployment

Check the real Worker, not a mock:

1. `GET /health` answers `200` with the version you deployed.
2. `GET /openapi.json` lists the operations you expect. `verifyContract` from
   `@arbol-ai/maximus/testing` checks it and its YAML twin.
3. An operation without a token answers `401` with a `WWW-Authenticate` challenge.
4. An operation with a real token for a test organization succeeds.
5. With MCP, `tools/list` with a token holding `<namespace>:mcp:use` lists the tools that token may
   call.
6. RPC operations: call them through a real caller deployment.

Record each check's status, request id and timing. Keep tokens and raw responses in a private,
ignored directory (for example `.private/`, mode `0700`, files `0600`), and never print sensitive
bodies to shared logs. A provider failure during verification is a failure, not evidence that there
is no data. Stop when it is unclear which credential or account a check is using.

Verify MCP directly against the Worker, separately from any third-party catalog that calls it. When
you study a provider for an integration, keep raw evidence in the same private directory with an
index of URLs, times and hashes; scripts that download pages bound their downloads and never run
downloaded JavaScript.

A firewall or WAF in front of the Worker is an additional perimeter. It is not a substitute for
operation scopes, and every operation still checks its token.

## Environments

Give a preview or staging environment its own audience, state and credentials. A token for one
environment must not be valid in another, and a test must never write to production state.

`cf workers versions create` uploads a version without deploying it (`--preview-alias` gives it a
preview URL), `cf previews deploy` deploys a branch preview, and `cf workers deployments create` sends
traffic to an earlier version.
