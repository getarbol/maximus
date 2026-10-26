# Worker composition

`createWorker` turns an application into a Worker and composes everything else the Worker serves:
webhooks, prefix protocols, static assets, other handlers and entrypoints. Every option below runs
inside the same native HTTP handler, so request ids, security headers and diagnostics cover it.

```ts
import { mcp } from '@arbol-ai/maximus/mcp';
import { createWorker } from '@arbol-ai/maximus/workers';

const worker = createWorker(app, {
  transports: [mcp()],
  routes: { '/webhooks/payments': paymentWebhook },
  http: { basePath: '/api', mounts: { '/files': serveFiles } },
  handlers: { scheduled: runScheduledJobs },
});

export default worker.handler; // fetch, plus your other handlers
export const NotesService = worker.entrypoint; // native RPC methods
```

| Returned               | Use                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `handler`              | The Worker's default export: `fetch` plus `handlers`.                                      |
| `entrypoint`           | A `WorkerEntrypoint` class whose methods are the `rpc` operations. Export it under a name. |
| `service(Class)`       | Wraps your own `WorkerEntrypoint` with diagnostics.                                        |
| `durableObject(Class)` | Wraps a Durable Object class the same way.                                                 |

## Plain routes

Some callers cannot send a bearer token: a provider's webhook signs its body, a signed download link
carries its own signature, an OAuth callback carries a code. Serve them as plain routes, by exact
path:

```ts
import { readBodyBytes, standardErrors } from '@arbol-ai/maximus';
import type { HttpRoute } from '@arbol-ai/maximus';
import { checkSchema } from '@arbol-ai/maximus/schemas';

async function validSignature(secret: string, signature: string | null, body: Uint8Array<ArrayBuffer>) {
  if (!signature || !/^[0-9a-f]{64}$/u.test(signature)) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const expected = Uint8Array.from(signature.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
  return crypto.subtle.verify('HMAC', key, expected, body);
}

export const paymentWebhook: HttpRoute<Env> = async (request, env, context) => {
  if (request.method !== 'POST') {
    return context.fail(standardErrors.methodNotAllowed.create(), { allow: 'POST' });
  }
  const body = await readBodyBytes(request, { maxBytes: 64 * 1024, signal: request.signal });
  if (!body.ok) {
    return context.fail(
      body.error.data.reason === 'too_large'
        ? standardErrors.tooLarge.create()
        : standardErrors.invalidInput.create()
    );
  }
  // Verify the exact bytes before treating any of them as data.
  if (!(await validSignature(env.PAYMENTS_WEBHOOK_SECRET, request.headers.get('x-signature'), body.value))) {
    return context.fail(standardErrors.unauthorized.create(), { 'www-authenticate': 'Signature' });
  }
  let event;
  try {
    event = checkSchema(PaymentEventSchema, JSON.parse(new TextDecoder().decode(body.value)));
  } catch {
    return context.fail(standardErrors.invalidInput.create());
  }
  if (!event.success) {
    return context.fail(standardErrors.invalidInput.create());
  }
  // Record the event durably and answer quickly; do the work elsewhere.
  await env.PAYMENT_EVENTS.send(event.data);
  return new Response(null, { status: 204 });
};
```

- A plain route has no principal and is absent from OpenAPI. It owns its authentication completely
  and must verify before it reads the request as data.
- `context.requestId` is the request id, `context.fail(failure, headers?)` answers a catalog failure
  in the standard envelope, and `context.waitUntil(promise)` is best-effort background work.
- A route may set its own `cache-control` (a signed file link may be cacheable); every other response
  is `private, no-store`.
- An exception answers the `INTERNAL_ERROR` envelope.
- Paths are exact. The versioned namespace (`/v<n>/…`), the service's own paths, operation paths and
  transport paths are reserved. A route may sit beneath a transport's path, such as `/mcp/other`, because a
  transport answers only its exact path.

## Prefix mounts

`http.mounts` hands a whole path namespace to a protocol handler with the same signature as a plain
route:

```ts
http: { mounts: { '/files': serveFiles, '/files/archive': serveArchive } },
```

A mount owns its prefix and every slash-delimited descendant: `/files` matches `/files` and
`/files/a/b`, never `/files-extra`. With nested mounts, the longest prefix wins. A mount may not
overlap the service's own paths, transports, plain routes or operation paths.

## Base path and health

```ts
http: { basePath: '/api', healthPath: '/healthz' },
```

- `basePath` serves operations and discovery below a prefix: `/api/v1/notes`, `/api/openapi.json`,
  `/api/health`. OpenAPI's server URL and the `WWW-Authenticate` metadata URL include it. Transports,
  plain routes and mounts stay absolute (`/mcp`, not `/api/mcp`).
- `healthPath` moves the liveness endpoint to an absolute path of your choice. It never probes
  dependencies.

If a proxy in front of the Worker removes the prefix instead, leave `basePath` unset and set the
application's `origin` to the public base URL, including the prefix, so documents and discovery
advertise the URL callers actually use. The token audience stays whatever you configured.

## Hooks

```ts
http: {
  before: async (request) => {
    const url = new URL(request.url);
    return url.hostname === 'www.notes.example.com'
      ? Response.redirect(`https://notes.example.com${url.pathname}${url.search}`, 308)
      : null;
  },
  aroundOperation: async (request, env, operation, run) => {
    const session = await openSession(env.DB, operation.effect);
    try {
      return await run({ ...env, DB: session });
    } finally {
      await session.close();
    }
  },
},
```

- `before(request, env, context)` runs for every request, after origin pinning and before any route.
  Return a `Response` to answer, or `null` to continue. Use it for canonical redirects and
  product-wide admission.
- `aroundOperation(request, env, { name, effect }, run)` wraps only a matched HTTP operation. Call
  `run(scopedEnv)` exactly once: token admission, body reading and execution all run inside it, with
  that environment. Metadata, MCP and plain routes bypass it.
- `fallback(request, env, context)` answers paths outside every API, versioned, service-owned,
  `/.well-known` and transport namespace. A miss inside those namespaces stays a native `404`, so an
  API typo never receives your web page.

## Static assets

`assets` serves a single-page application or other build output from a Workers assets binding:

```ts
assets: {
  binding: 'ASSETS',
  pages: { paths: ['/', '/settings'], patterns: [/^\/notes\/[0-9a-f-]{36}$/u] },
  files: ['/manifest.webmanifest', '/sw.js'],
  immutablePrefixes: ['/assets/'],
  headers: { 'content-security-policy': "default-src 'self'" },
},
```

| Path kind                          | Served                                           | `cache-control`                       |
| ---------------------------------- | ------------------------------------------------ | ------------------------------------- |
| `pages.paths` and `pages.patterns` | The shell, `pages.shell` (default `/index.html`) | `no-store`                            |
| `files`                            | The file itself                                  | `no-cache`                            |
| Below `immutablePrefixes`          | The file itself                                  | `public, max-age=31536000, immutable` |
| Anything else                      | The `404 NOT_FOUND` envelope                     | `no-store`                            |

A non-200 answer from the binding keeps its status and becomes `no-store`.

Only `GET` and `HEAD` are served; other methods answer `405` with `Allow: GET, HEAD`. The binding
receives only the path and method: no credentials, query or request headers. `headers` (or a
function of the request and environment) adds browser policy but cannot change `content-type` or
`cache-control`, and `nosniff` is always set. Patterns may not use the global or sticky flags.
`assets` and `http.fallback` cannot both be set.

The pages are declared once, here. The API's discovery documents keep `/`,
`/openapi.json`, `/openapi.yaml` and `/health`; a web app that needs `/` as a page moves the API below
a prefix with `http.basePath` (`/api/openapi.json`, `/api/v1/…`).

Configure the binding so the Worker decides every response, in `cloudflare.config.ts`:

```ts
assets: { htmlHandling: 'none', notFoundHandling: 'none', runWorkerFirst: true },
env: { ASSETS: bindings.assets() /* , … */ },
```

### One Vite build for the Worker and its web app

With the [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/), which `cf`
builds the Worker with, one Vite build makes the Worker and the web app together:
`cf build` puts the app's build in the Worker's assets, and `cf dev` runs both on one dev server
with hot reload. There, Vite's dev server stands behind the assets binding, and every request
reaches the Worker first, Vite's own client and modules included. Set `development` so the Worker
forwards to it, as it came, any `GET` it does not serve as a page, file or immutable asset:

```ts
assets: {
  binding: 'ASSETS',
  pages: { paths: ['/', '/settings'] },
  immutablePrefixes: ['/assets/'],
  development: import.meta.env.DEV,
},
```

The production build replaces `import.meta.env.DEV` with `false`, so a deployed Worker never forwards.
A strict `content-security-policy` must also let the dev server's inline
React Refresh script run in development; the built app has none.

## Other handlers

`handlers` adds the rest of `ExportedHandler` (`scheduled`, `queue`, `email`, …) to the default
export. `scheduled` runs inside the application's diagnostics context; other handlers run as written.
The environment and execution context are Cloudflare's.

## Origins

`http.origins` lists exact HTTPS origins. Any other origin answers `404` before hooks, metadata or
token handling. A Worker that serves several hosts with different policies builds one handler per
host and dispatches explicitly.

## The route resolver

`createHttpRouteResolver(definitions)` exposes the router for code that must choose something per
route before invoking the handler, such as a database session:

```ts
import { createHttpRouteResolver } from '@arbol-ai/maximus';

const routes = createHttpRouteResolver(
  Object.entries(app.operations).map(([name, operation]) => ({ name, http: operation.http }))
);
const match = routes.match(request.method, new URL(request.url).pathname);
// match: { definition, parameters } or null
```

It applies the same exact matching and parameter decoding, and does nothing else: no
authentication, no validation. `ownsPath(pathname)` says whether any method's route covers a path.

## Reserved paths

| Path                                                                                                                                                   | Owner                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `/`, `/health`, `/openapi.json`, `/openapi.yaml`, `/openapi.yml`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp` | The service's own endpoints, below `basePath` when set |
| `/v<n>/…`                                                                                                                                              | Operations                                             |
| Each transport's path, `/mcp` by default                                                                                                               | The transport, exactly                                 |
| `tokens.resources` keys                                                                                                                                | OAuth resource metadata                                |

Plain routes, mounts and transports that collide with these, or with each other, fail when the Worker
is built.
