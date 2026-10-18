# Transports

| | HTTP | MCP | Native RPC |
| --- | --- | --- | --- |
| Opt in | `http: { method, path }` | `mcp: { name, idempotent }` + `transports: [mcp()]` | `rpc: true` or `{ callers }` + app `rpc.callers` |
| Caller proves | Bearer token | Bearer token with `<namespace>:mcp:use` | Service Binding props `{ caller }` |
| Scopes checked | Yes | Yes, also to list tools | No |
| Success | Envelope `{ success: true, data, error: null, metadata: { requestId } }` | `structuredContent` + JSON text | `{ ok: true, value }` |
| Failure | Catalog status + `{ success: false, data: null, error, metadata }` | `isError: true`, failure JSON text | `{ ok: false, error }` |

All three share input validation, `derive`, middleware, the handler and output validation.

## HTTP and OpenAPI

- Responses always carry `x-request-id`, `cache-control: private, no-store`, `nosniff` and
  `server-timing`. A `401` carries `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`.
- `/openapi.json`, `/openapi.yaml`, `/openapi.yml`: OpenAPI 3.1 of the public HTTP operations (never
  an internal one): scopes as OAuth security requirements (`<issuer>authorize`, `<issuer>oauth/token`
  by default), one response per failure status naming the codes that answer with it
  (`FailureResponse` narrowed to them), and the operation extensions `x-required-scopes`,
  `x-scope-match` (with more than one scope), `x-conditional-scopes`, `x-effect`, `x-mcp-tool` (with
  `x-mcp-idempotent`, `x-mcp-open-world`), `x-native-rpc`, `x-max-body-bytes` and
  `x-max-output-bytes` (the limits in force), `x-body`, `x-input-headers` and `x-response`. The root
  holds only `openapi`, `info`, `servers`, `paths` and `components`; the tag defaults to the
  operation's name. Every `$ref` is local: a schema's `$id` (shared schemas, `PageInfo`, each `Page`,
  recursive schemas) becomes `#/components/schemas/<id>`; every envelope's `metadata` refers to
  `ResponseMetadata` and every failure narrows `Failure`. MCP tool schemas stay self-contained: named
  schemas written in place, without `$id`.
- `createOpenApi(app)` builds that same document at build time.
- Rate limiting: `rateLimit: { binding, retryAfter }` (a Workers rate limit binding), keyed by
  organization and actor after authentication; 429 `RATE_LIMITED`.
- Typed callers: `createClient<typeof app>(baseUrl, token, { response: 'data' })` from
  `@arbol-ai/maximus/client`, importing `app` as a type only. HTTPS (plain `http://` only on
  loopback), no redirects, no write retries, `fetch` option for tests.

## MCP

- Endpoint `/mcp` (or `mcp({ path })`, `/` for a dedicated host), Streamable HTTP, stateless.
  Clients send `accept: application/json, text/event-stream`; answers are SSE `data:` lines.
- Tools visible to a token: its scopes match the operation and `actorKinds` allows its actor. 50 per
  `tools/list` page. Calls of unseen tools are JSON-RPC errors.
- Annotations: `readOnlyHint` = effect read, `destructiveHint` = effect delete, `idempotentHint` =
  `mcp.idempotent`, `openWorldHint` = `mcp.openWorld ?? true`. Hints are not authorization.
- App `mcp`: `instructions`; `guides: [{ name, title, text }]` (resources and prompts);
  `skills: [{ name, description, text }]` (MCP Skills extension, `skill://<name>/SKILL.md`);
  `skillTool: 'read_skill'` (skills as one read-only tool, first in the catalog).
- A union input lists as one object (every member's fields, the discriminator as an `enum`), since
  hosts refuse a root `anyOf`; each call is still checked against the exact union.
- An unexpected failure of the server answers the JSON-RPC `Internal error`, never its own text, and
  is reported as `maximus.unexpected`.
- Resources `openapi-json` and `openapi-yaml` expose the public contract, named by the URLs that
  serve it (below `http.basePath`); reading grants nothing.
- The endpoint admits the largest `maxBodyBytes` among the tools the caller may call and holds each
  call to its own.
- A `bearer` token scheme cannot mount MCP. Keep credential and permission management out of tools.

## Native RPC

Owner:

```ts
maximus<Env>({ /* ... */ rpc: { callers: ['orders'] } })
  .operation('quoteItems', { /* ... */ rpc: true }, handler);
export const PricingService = createWorker(app).entrypoint;
```

Owner `cloudflare.config.ts` declares `exports: { PricingService: exports.worker() }` and exports its
`defineWorker` definition; caller `cloudflare.config.ts`:

```ts
PRICING: bindings.worker({ worker: pricingWorker, exportName: 'PricingService', props: { caller: 'orders' } }),
```

Locally, the caller's `vite.config.ts` runs the owner beside it:
`cloudflare({ auxiliaryWorkers: [{ config: pricingWorker, devOnly: true }] })`.

```ts
// Env: PRICING: Service<typeof PricingService>
const quote = await env.PRICING.quoteItems(principal, { items }); // forward the verified principal
```

- The owner requires props exactly `{ caller }` with an admitted caller, and a principal that matches
  `{ actorId, actorKind, organizationId, requestId }` exactly; otherwise `UNAUTHORIZED`.
- No scopes are checked and `authority` is absent: the calling deployment is trusted. When the owner
  must verify the original authority, call its HTTP route with the caller's token
  (`authority.token`).
- Owner failures belong to the owner's catalog: translate them before returning them, or the
  caller's output check turns them into `INTERNAL_ERROR`. Catch thrown calls (owner unreachable).
- `worker.service(Class)` and `worker.durableObject(Class)` wrap your own entrypoints and Durable
  Objects with diagnostics and adapters. Never rename Durable Object classes or migration tags.

## Plain routes and Worker composition

```ts
createWorker(app, {
  routes: { '/webhooks/payments': paymentWebhook },     // exact paths, no principal, not in OpenAPI
  http: {
    basePath: '/api',                                  // operations + discovery below /api; transports stay absolute
    mounts: { '/files': serveFiles },                  // prefix + slash-delimited descendants
    before: async (request) => null,                   // first; a Response answers
    aroundOperation: async (request, env, op, run) => run(env), // matched HTTP operations; run once
    origins: ['https://notes.example.com'],            // exact HTTPS origins, others 404
    healthPath: '/healthz',
  },
  assets: { binding: 'ASSETS', pages: { paths: ['/'] }, immutablePrefixes: ['/assets/'] },
  handlers: { scheduled: runJobs },
});
```

- A plain route (`HttpRoute<Env>`: `(request, env, { requestId, fail, waitUntil })`) verifies its
  own signature on the exact bytes (`readBodyBytes(request, { maxBytes, signal })`) before treating
  them as data, answers failures with `context.fail(failure, headers?)`, and may set its own
  `cache-control`.
- Reserved: `/v<n>/…`, native paths, transport paths, `tokens.resources` keys. Collisions fail at
  construction. A route may sit beneath a transport's path.
- `fallback` (or `assets`, not both) answers only paths outside API, versioned, native,
  `/.well-known` and transport namespaces.
- Assets: configure the binding with `html_handling: "none"`, `not_found_handling: "none"` and
  `run_worker_first: true`.
