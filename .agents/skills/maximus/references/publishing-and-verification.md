# Deploying and verifying

## A new service (`@arbol-ai/maximus`)

Run `bunx @arbol-ai/maximus init <dir> --name <name> --layout project` for a Vite+ project on the CLI's
own release. Configure its origin and token policy in `maximus.config.ts`. The compatible service
layout is still available and keeps `src/app.ts`. Use the generated package scripts: Vite+ owns
development, builds and checks; Cloudflare owns types and deployment. Maximus prepares the source
graph before Vite loads the generated Worker.

`createOpenApi(app)` builds the document the origin serves at `/openapi.json`, for SDKs or a contract
check at build time. Nothing is published from the service: deploying it is the release.

## Before deploying

```sh
bun run verify      # preparation, types, lint/format and build; no tests
# Read .cloudflare/output/v0/workers/default/worker.config.json: no development token.
cf deploy --prebuilt --mode production --dry-run
cf deploy --prebuilt --mode production   # --dry-run first; cf auth login or CLOUDFLARE_API_TOKEN
```

`nodejs_compat` on; secrets as `bindings.secret()`, uploaded with `cf deploy --secrets-file` or kept
in Secrets Store, never in `bindings.text()`; `.dev.vars` local only, and the development token
declared for development mode alone; Durable Object class names unchanged and declared as exports; preview
environments use their own audience, state and credentials.

## After deploying

Verify the real Worker: `/health` version; `/openapi.json` operations (`verifyContract`); `401`
without a token; a real token call for a test organization; MCP `tools/list`;
RPC calls through a real caller. Keep tokens and raw responses in an ignored `.private/`
(0700/0600) and never print sensitive bodies to shared logs. Mocks are never evidence of a live
deployment.

## Releasing Maximus itself (framework repository)

Run `bun run verify` for builds, workspace types, lint and format. Inspect a packed tarball and build
consumers from it; never publish `workspace:` or `file:` dependencies. After publication, install from
the registry, produce the consumer's dry bundle and verify the deployed service. Test suites and
package smoke tests are separate: run them only after an explicit human request. Neither release
authorization nor a successful build is evidence that tests were authorized or passed.
