# Deploying and verifying

## A new service (`@arbol-ai/maximus`)

One command, `bunx @arbol-ai/maximus init <dir> --name <name>`: a starter project on the CLI's own
release, scripted with `cf`; it passes `bun run verify` as generated. Replace the placeholder origin,
audience and issuer in `src/app.ts` before deploying. Develop, build and deploy with `cf dev`,
`cf build`, `cf workers types` and `cf deploy`: Maximus does not wrap them.

`createOpenApi(app)` builds the document the origin serves at `/openapi.json`, for SDKs or a contract
check at build time. Nothing is published from the service: deploying it is the release.

## Before deploying

```sh
bun run typecheck   # cf build does not typecheck
bun run test
cf build            # then read .cloudflare/output/v0/workers/default/worker.config.json: no dev token
cf deploy --prebuilt --mode production   # --dry-run first; cf auth login or CLOUDFLARE_API_TOKEN
```

`nodejs_compat` on; secrets as `bindings.secret()`, uploaded with `cf deploy --secrets-file` or kept
in Secrets Store, never in `bindings.text()`; `.dev.vars` local only, and the development token
declared for `cf dev` alone; Durable Object class names unchanged and declared as exports; preview
environments use their own audience, state and credentials.

## After deploying

Verify the real Worker: `/health` version; `/openapi.json` operations (`verifyContract`); `401`
without a token; a real token call for a test organization; MCP `tools/list`;
RPC calls through a real caller. Keep tokens and raw responses in an ignored `.private/`
(0700/0600) and never print sensitive bodies to shared logs. Mocks are never evidence of a live
deployment.

## Releasing Maximus itself (framework repository)

`bun run verify` (build, typecheck, lint, tests, packed-package and isolation checks), packages in
dependency order from packed tarballs, never with `workspace:` or `file:` dependencies; then install
from the registry, run consumers' workerd tests and dry bundles, and verify a real deployment.
