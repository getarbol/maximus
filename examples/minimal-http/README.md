# Minimal HTTP service

A notes service with three HTTP operations, its runtime OpenAPI document and a test. It is the code
[Getting started](../../docs/getting-started.md) walks through.

| File                   | Contains                                                                         |
| ---------------------- | -------------------------------------------------------------------------------- |
| `src/app.ts`           | The application: configuration, schemas, the error catalog and three operations. |
| `src/tokens.ts`        | OAuth verification plus a development token accepted only on `localhost`.        |
| `src/index.ts`         | The Worker.                                                                      |
| `tests/notes.test.ts`  | The service tested in Node through `createHttpHandler`.                          |
| `cloudflare.config.ts` | The Worker for `cf`, with its KV binding and the development token.              |

## Run it

```sh
echo "DEVELOPMENT_TOKEN=$(openssl rand -hex 32)" > .dev.vars
bun run dev                     # cf dev, on http://localhost:5173
```

## Try it

```sh
TOKEN=$(sed 's/^DEVELOPMENT_TOKEN=//' .dev.vars)

curl -s -X POST http://localhost:5173/v1/notes \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"Buy coffee"}'

curl -s http://localhost:5173/v1/notes -H "authorization: Bearer $TOKEN"
curl -s http://localhost:5173/v1/notes/<noteId> -H "authorization: Bearer $TOKEN"

curl -s http://localhost:5173/openapi.json
curl -s -i http://localhost:5173/v1/notes      # 401 with a WWW-Authenticate challenge
```

## Test it

```sh
bun run test
```

The test replaces the KV namespace with a `Map`, because the application declares only the store
interface it uses.

## Deploy it

Set `ISSUER` and `AUDIENCE` in `src/tokens.ts` to your authorization server and `origin` to your public
URL, then build, check and deploy that build. `cf deploy` creates the KV namespace, since
`cloudflare.config.ts` names no id; add the id it reports there to keep the same namespace.

```sh
bun run build                   # cf build
bunx cf auth login
bunx cf deploy --prebuilt --mode production
```

The development token is declared for `cf dev` alone, so the deployed Worker never has it.
