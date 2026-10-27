# Transports

|                | HTTP                                                                 | MCP                                                              | Worker RPC                                                                                  |
| -------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Opt in         | Every route                                                          | `mcp: { name }` in a route's contract, or a file of `mcp/tools/` | `rpc: true` or `{ callers }` in the contract, and the caller in `maximus()`'s `rpc.callers` |
| Caller proves  | An access token that holds the operation's scope                     | The same, and `<namespace>:mcp:use`                              | Its Service Binding's props, `{ caller }`                                                   |
| Scopes checked | Yes                                                                  | Yes, to list tools and to call them                              | No: the calling deployment is trusted                                                       |
| Success        | `{ success: true, data, error: null, metadata: { requestId } }`      | The output as `structuredContent`, and as JSON text              | `{ ok: true, value }`                                                                       |
| Failure        | The code's status, `{ success: false, data: null, error, metadata }` | A result with `isError: true`, the failure as text               | `{ ok: false, error }`                                                                      |

All three share the input check, `context.ts`, operation middleware, the handler and the output check.

## HTTP and OpenAPI

- The API answers below `/api`: routes, `/api/openapi.json`, `/api/openapi.yaml` and OAuth discovery at
  `/api/.well-known/oauth-protected-resource`. `/health` answers
  `{ "status": "ok", "service": "<name>", "version": "<version>" }`. None of these needs a token.
- Every answer carries `x-request-id`, `x-content-type-options: nosniff`, `server-timing` and
  `cache-control: private, no-store` (a page may set its own). A `401` carries
  `www-authenticate: Bearer resource_metadata="<origin>/api/.well-known/oauth-protected-resource"`.
- The OpenAPI 3.1 document holds every public route, never an internal one or a tool only MCP serves, with
  its scopes as OpenAPI `security` requirements, one response per failure status, every named schema as a
  component, and the extensions `x-required-scopes`, `x-effect`, `x-mcp-tool`, `x-native-rpc`, `x-max-body-bytes` and
  the others the wire formats reference lists.
- A caller in TypeScript sends `fetch` with the caller's token and reads the envelope, typing each call with
  `Static` of schemas it imports from a module that imports no route.

## MCP

- The Worker serves `/mcp` when a route or tool declares MCP, or when `mcp/` holds Markdown: the MCP SDK over
  Streamable HTTP, one stateless server per request. A client sends
  `accept: application/json, text/event-stream`; the answer is a server-sent event whose `data:` line holds
  the JSON-RPC message.
- `tools/list` lists the tools the caller's scopes and actor kind admit, 50 per page. A call to a tool the
  caller cannot see is a JSON-RPC error, `Tool not found`.
- Hints follow the declaration: `readOnlyHint` for a read, `destructiveHint` for a delete, `idempotentHint`
  from `idempotent`, `openWorldHint` from `openWorld`, `true` unless declared. Hints never authorize.
- `mcp/instructions.md` is sent to every client that connects. `mcp/guides/<name>.md`, starting with its
  `# title`, is a resource at `<origin>/guides/<name>` and a prompt. `mcp/skills/<name>.md`, with a
  frontmatter `description:`, is an Agent Skill, `skill://<name>/SKILL.md`. All of it is static text for
  every caller: never tenant data.
- The OpenAPI document is served as the resources `openapi-json` and `openapi-yaml`; reading them grants
  nothing.
- A union input lists as one object with every member's fields; each call is still checked against the exact
  union.
- Every message of a JSON-RPC batch passes the rate limit before any of them runs.
- An unexpected failure answers the JSON-RPC error `Internal error`, never its text, and is reported as
  `maximus.unexpected` with the surface `mcp`.

See [MCP](https://github.com/getarbol/maximus/blob/main/docs/guides/mcp.md).

## Worker RPC

The owner names the services allowed to call it, by their names, and each route it serves over RPC says so:

```ts
// pricing/vite.config.ts: maximus({ name: 'example-pricing', …, rpc: { callers: ['example-orders'] } })
// pricing/routes/v1/quotes.post.ts, also the RPC method quoteItems
export default defineHandler(
  ({ input, fail }) => {
    const priced = priceItems(input.items);
    if (!priced.ok) {
      return fail('UNKNOWN_SKU', { index: priced.unknownIndex });
    }
    return priced.quote;
  },
  {
    description: 'Price a list of catalog items for the calling organization.',
    effect: 'read',
    operationId: 'quoteItems',
    input: { items: ItemsSchema },
    output: QuoteSchema,
    failures: ['UNKNOWN_SKU'],
    rpc: true,
    visibility: 'internal',
  }
);
```

The generated Worker exports the methods as its `Service` entrypoint, one per route or tool that declares
`rpc`, named by the operation. `bunx maximus openapi` writes the owner's RPC document, `openapi.rpc.json`,
beside `openapi.json`: each method as `POST /rpc/<method>` whose body is its whole input, its answer and
failures as named components, and `x-rpc-callers`. Commit both; `maximus openapi --check` fails when the
routes changed and the files did not.

The caller binds the owner by its Worker's name and that document, and imports nothing of the owner's
project:

```ts
// orders/vite.config.ts
maximus({
  name: 'example-orders',
  // …
  services: { PRICING: { worker: 'example-pricing', openapi: '../pricing/openapi.rpc.json' } },
});
```

`maximus()` binds `PRICING` to the owner's `Service` entrypoint with the props `{ caller: 'example-orders' }`,
this service's name. `maximus prepare` writes `.maximus/services/pricing.ts` from the document:
`PricingService`, and each method's input, output and failure union, so `env.PRICING` is
`Service<PricingService>`. A handler imports those types from `#maximus/services/pricing`, forwards its
verified principal, catches a call that throws and translates the owner's failures, narrowed by their code,
into its own catalog: see [errors-and-results.md](errors-and-results.md#failures-of-other-services).

- The owner admits a call only when the binding's props are exactly `{ caller }` with an allowed caller and
  the principal is exactly `{ actorId, actorKind, organizationId, requestId }`; otherwise `UNAUTHORIZED`.
- No scope is checked and `authority` is absent: the calling deployment is trusted. When the owner must
  verify the original caller's token, call its HTTP route with that token (`authority.token`) instead.
- Several services of one repository: one `services` entry per binding, each to the document the other
  publishes, each typed in its own `.maximus/services/<binding>.ts`. A service can be both an owner
  (`rpc.callers`) and a caller (`services`). From another repository, the document is a copy the owner's CI
  publishes and the caller's updates.
- The caller's type check fails the moment the owner's document changes in a way its calls do not follow.
- Under `vp dev`, start the owner first, then the caller, which finds it by name. Deploy the owner first,
  too: the caller's binding names it.

See [Worker RPC](https://github.com/getarbol/maximus/blob/main/docs/guides/worker-rpc.md) and
`examples/worker-rpc` in the Maximus repository.

## A Worker composed by hand

A project's conventions cover routes, tools, pages (webhooks included), middleware, telemetry and event
handlers. A plain route below a transport's path, a mounted protocol, hooks around requests and operations,
pinned origins, or entrypoints of your own need a Worker composed by hand: the builder, `maximus()` from
`@arbol-ai/maximus`, with `.derive()`, `.use()`, `.operation()`, `.mount()` and `.build()`, served by
`createWorker(app, { transports, routes, http, assets, handlers })` from `@arbol-ai/maximus/workers`. A
plain route, like a page, verifies its own signature on the exact bytes (`readBodyBytes(request,
{ maxBytes })`, then `@arbol-ai/maximus/webhooks`) before it treats them as data.
That Worker is built as any other, with its own module as its entry and `nodejs_compat`, not through
`maximus()` from `@arbol-ai/maximus/vite`.

See [Worker composition](https://github.com/getarbol/maximus/blob/main/docs/guides/worker-composition.md).
