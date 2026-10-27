# Deploying

## Before the first deployment

- `origin`: the Worker's public HTTPS URL. A `workers.dev` origin,
  `https://<name>.<subdomain>.workers.dev`, is served there; any other host becomes the Worker's custom
  domain, in a zone of the same account, unless `domains` or a fetch trigger route the Worker. Tokens must
  carry the origin as their audience unless `tokens.audience` says otherwise.
- `tokens.issuer`: the OAuth authorization server whose access tokens the deployed Worker accepts. It
  accepts no development token.
- `bunx cf auth login` once on a machine; CI sets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## Deploy

```sh
bun run deploy                                               # bun run verify, then cf deploy --prebuilt --mode production
bun run deploy --tag "$(git rev-parse --short HEAD)"         # records what the version is
bunx cf deploy --prebuilt --mode production --dry-run        # checks the build and lists its bindings, uploads nothing
bun run preview                                              # the production build, locally
```

`vp build` writes the Build Output to `.cloudflare/output/`; `cf deploy --prebuilt` deploys it as it is.

## Secrets

- Declare each one as `bindings.secret()` in `env`. Under `vp dev` its value comes from `.dev.vars`.
- The first deployment supplies every declared secret, from a file outside the repository (`NAME=value`
  lines or JSON): `bun run deploy --secrets-file .env.production`. Without it, the deployment stops with
  `The following required secrets have not been set`.
- Later deployments keep each value unless their secrets file brings a new one.
  `bunx cf workers secrets update <NAME> --worker <name>` changes one alone, as a new version.
- Never put a secret in `bindings.text()`, code, the repository or a log. Never set `DEVELOPMENT_TOKEN` on a
  deployed Worker; `maximus()` refuses to declare it.

## Resources

- The deployment creates a KV namespace without an id, an R2 bucket and a queue by their names, the queue
  consumers and cron triggers, the storage of each exported Durable Object class and the custom domain. It
  does not write ids back into `vite.config.ts`.
- You create a D1 database and apply its migrations before deploying the Worker that reads them:
  `bunx cf d1 create --name notes` prints the id the binding names, and
  `bunx cf d1 migrations apply <database-id>` applies `migrations/*.sql` not yet applied.
- A Worker that another binds deploys first.
- A Durable Object class's name is its storage's: renaming or removing it is a migration declared in
  `exports`.

## CI

The starter's `.github/workflows/ci.yml` runs on every pull request, on every push to `main` and on demand:
it installs from the lockfile without install scripts, runs `bun run verify` and a deploy dry run, and on a
push to `main` deploys with the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, which
only that step receives. It passes no secrets file: deploy a Worker's first version, with its secrets, from a
machine.

## Check the deployment

A suite over stand-ins proves nothing about a deployment, and a mock is never evidence of one. Check the
deployed Worker:

1. `GET /health` answers `200` with the version you deployed.
2. `/api/openapi.json` lists the operations you expect; `verifyContract(fetch, '<origin>/api')` also checks
   the YAML document.
3. A route without a token answers `401` with `www-authenticate: Bearer resource_metadata="<origin>/api/.well-known/oauth-protected-resource"`,
   whose document names the issuer.
4. `/mcp` without a token answers `401`.
5. A real access token for a test organization succeeds.
6. RPC methods answer a real calling Worker.

Keep tokens and raw responses out of the repository and of shared logs (the starter ignores `.private/`). A
failure of another service during a check is a failure, never evidence that there is no data. Stop when it is
unclear which account or credential a check uses.

See [Deploying](https://github.com/getarbol/maximus/blob/main/docs/guides/deploying.md).
