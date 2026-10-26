# Authentication and scopes

Every HTTP and MCP call carries a bearer token. Maximus turns it into a verified principal, checks the
operation's scopes, and only then reads the input. This guide covers the default OAuth verification,
custom verification, scopes, token schemes and OAuth discovery.

## How a call is authenticated

1. The request must carry `Authorization: Bearer <token>`, at most 16 384 characters. A request with
   an `x-api-key` header is refused. Without a custom resolver, the token must look like a compact
   JWT.
2. The token is verified, by default as an OAuth access token, or by your `tokens.resolve`.
3. The resulting principal must match the principal schema exactly, and its client must be
   consistent with its actor kind.
4. The token's scopes must satisfy the operation (or `<namespace>:mcp:use`, for the MCP endpoint).

Steps 1–3 failing answers `401 UNAUTHORIZED`; step 4 answers `403 FORBIDDEN`. This happens after
routing (so an unknown path is still `404`) and before the rate limit, the body and the handler.

## OAuth access tokens

```ts
maximus<Env>({
  // ...
  tokens: { issuer: 'https://auth.example.com/', audience: 'https://notes.example.com' },
});
```

| Check            | Rule                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Keys             | The issuer's JWKS at `tokens.jwksUri`, or `.well-known/jwks.json` resolved against the issuer. HTTPS only; cached for ten minutes. |
| Algorithm        | `RS256`                                                                                                                            |
| Issuer, audience | Exactly `tokens.issuer`, and `tokens.audience` or any one audience of its list                                                     |
| Time             | `exp` required, five seconds of clock tolerance                                                                                    |

A service that also accepts tokens issued for a gateway in front of it lists both audiences, its own
first: `audience: ['https://notes.example.com', 'https://api.example.com']`. A token for either
is verified the same way; one for any other audience answers `401`. The first audience stays the
resource OAuth discovery names.

The verified claims become the principal. The defaults are the standard OAuth claims (RFC 9068) and
Auth0's conventions:

| Claim                | Becomes                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sub`                | `actorId`. A subject `<client id>@clients` is a machine (`actorKind: 'service'`); anyone else is a person (`'user'`). A subject ending in `@clients` that names another client is refused. |
| `org_id`             | `organizationId`. Required; 1 to 128 letters, digits, `_` and `-`, starting with a letter or digit.                                                                                        |
| `azp` or `client_id` | The client id, optional. If both are present they must be equal. Without one, the call has no `authority`.                                                                                 |
| `scope`              | The granted scopes: a space-separated string or a list. Absent, the token grants none.                                                                                                     |
| `permissions`        | What a person may do: a person holds only the granted scopes it also lists, and none when their token lacks it. A machine's scopes are never limited.                                      |

A person's scopes must appear in both because the client chooses which scopes it requests. Auth0
without RBAC, for one, grants whatever scopes an application asks for, so `scope` alone would let any
member of an organization give themselves an administrator's scope. With RBAC and **Add Permissions
in the Access Token** enabled on the API, Auth0 lists each person's permissions and its tokens work
as they are.

When your authorization server names them differently, say where with `tokens.claims`: each entry is a
claim name, or a dotted path into an object claim. A claim whose own name has dots, such as
`https://example.com/org_id`, is read as it is named.

```ts
tokens: {
  issuer: 'https://idp.example.com/',
  audience: 'https://notes.example.com',
  claims: { organization: 'tenant_id', permissions: 'roles' },
},
```

Two entries change a rule rather than a name:

- `permissions: false` trusts the granted scopes alone. Set it only for an authorization server that
  grants each person no more than they may hold, as Okta does when each scope's access policy rule
  admits only the groups that may hold it; never for one that grants whatever a client requests.
- `machineSubject: '{client}'` makes a subject equal to the client id a machine, as RFC 9068
  recommends for client-credentials tokens and as Okta and WorkOS issue them. Set it only when the
  authorization server assigns every client id, so that no client can take a person's subject
  (RFC 9068, section 5).

| Provider  | Settings                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth0     | None. Enable RBAC and **Add Permissions in the Access Token** on the API.                                                                                                                                                                                                                                                                                                                                                           |
| Okta      | `claims: { scopes: 'scp', client: 'cid', permissions: false, machineSubject: '{client}' }`, with `jwksUri`, `authorizationEndpoint` and `tokenEndpoint` at `<issuer>/v1/keys`, `/v1/authorize` and `/v1/token`. Add an `org_id` claim in the authorization server, and give each scope an access policy rule that admits only the groups that may hold it.                                                                          |
| WorkOS    | Session tokens: `claims: { scopes: 'permissions' }`, `jwksUri: 'https://api.workos.com/sso/jwks/<client id>'`, and an `aud` claim added by the JWT template. OAuth tokens: `claims: { machineSubject: '{client}' }`, with `jwksUri`, `authorizationEndpoint` and `tokenEndpoint` at `<issuer>/oauth2/jwks`, `/oauth2/authorize` and `/oauth2/token`; they list no permissions, so they grant scopes to machines and none to people. |
| Any other | The claims above, `algorithms` (`ES256`, `EdDSA`, …) and the endpoints; or [custom verification](#custom-verification) for anything else.                                                                                                                                                                                                                                                                                           |

`jwksUri`, `authorizationEndpoint` and `tokenEndpoint` default to Auth0's paths, `.well-known/jwks.json`,
`authorize` and `oauth/token`, each resolved against the issuer. Copy the others from your
server's `/.well-known/oauth-authorization-server` metadata (`jwks_uri`, `authorization_endpoint`,
`token_endpoint`). Maximus verifies tokens with the first; OpenAPI publishes the other two as the
OAuth flows' URLs.

Malformed claims, such as a `scope` that is neither a string nor a list of strings, refuse the token.

Always set `tokens.issuer`. There is no default authorization server: without one the application
builds, but every OAuth token is refused and `/openapi.json` answers `500`.

## Scopes

A scope is `<namespace>:<resource>:<action>`, lowercase, where `namespace` is the application's
`namespace`: `notes:notes:read`, `billing:invoices:write`. Construction refuses an operation whose
scope belongs to another namespace or is malformed.

```ts
scope: 'notes:notes:write',                        // one scope
scope: ['notes:notes:read', 'notes:notes:write'],  // any one of them: a write grant also reads
scope: ['notes:notes:read', 'notes:sites:read'],
scopeMatch: 'all',                                 // every one of them
```

OpenAPI publishes a list as alternative security requirements, and `scopeMatch: 'all'` as one
requirement with every scope. HTTP admission, MCP tool discovery and execution all use the same
matcher, `operationMatchesScopes(operation, granted)`; use `operationScopes(operation)` rather than
reading `operation.scope` when you need the list.

Three more controls narrow who may execute an operation:

- **`actorKinds: ['user']`** or **`['service']`** refuses the other kind with `FORBIDDEN`,
  independently of scopes.
- **`conditionalScopes`** declares scopes the handler checks itself for part of the operation, such
  as managing someone else's record. They must be namespaced and distinct from `scope`. An operation
  that declares them fails closed when the call has no token authority (ordinary RPC):

  ```ts
  async ({ authority }, input) => {
    if (input.owner !== 'self' && !authority?.scopes.includes('notes:notes:manage')) {
      return err(errors.forbidden.create());
    }
    // ...
  };
  ```

- **`visibility: 'internal'`** keeps a staff operation routed and scope-checked but removes it from
  OpenAPI, from `scopes_supported` and from the typed client; MCP lists it only to tokens that carry
  its scope. Give it a scope only a staff role holds. Hiding an operation never authorizes it.

Effects, MCP annotations, descriptions and obscure paths are never access control.

## Custom verification

`tokens.resolve` replaces the OAuth verification. Use it for credentials Maximus does not know: an
application-issued session, a workload key checked against your own store, a different issuer.

```ts
tokens: {
  issuer: 'https://auth.example.com/',
  audience: 'https://notes.example.com',
  async resolve(token, context) {
    const session = await verifySession(token, context?.env); // your cryptographic verification
    if (!session) {
      return err(errors.unauthorized.create());
    }
    return {
      actorId: session.userId,
      actorKind: 'user',
      organizationId: session.organizationId,
      scopes: session.scopes,
      client: { id: 'notes-web', class: 'human' },
    };
  },
},
```

- Return the principal, or a `Result`. A failure with code `FORBIDDEN` answers `403`; any other
  failure, and any thrown error, answers `401`.
- The principal is validated strictly: `actorId` (1–255 characters), `actorKind`, `organizationId`,
  `scopes` (at most 1000) and an optional `client` of class `human`, `machine` or `dcr`. A `machine`
  client must go with `actorKind: 'service'` and, outside `oauth+bearer`, an `actorId` equal to its
  client id or to `<client id>@clients`.
- Maximus still checks the operation's scopes against `scopes`.
- `context` is request-local: `env`, `request`, `surface` (`'http'` or `'mcp'`), `applicationScopes`
  and `background`. `applicationScopes` lists the scopes your operations and transports declare; map
  verified grants onto it, never treat it as a grant. Do not keep the context between requests, and
  never take authority from request headers or bodies.
- A resolver must verify the credential cryptographically before returning a principal. It owns
  every decision about which credential is valid right now.

Return a `client` when you have one: without it, calls have no `authority`, and operations with
`conditionalScopes` refuse them.

## Local development

To run a service with `cf dev` without an authorization server, accept one development token:

```ts
tokens: {
  issuer: 'https://auth.example.com/',
  audience: 'https://notes.example.com',
  development: { binding: 'DEVELOPMENT_TOKEN' },
},
```

Put a long random `DEVELOPMENT_TOKEN` in `.dev.vars`, which only `cf dev` reads, declare its binding in
`cloudflare.config.ts` for the development mode alone, and send it as the bearer token:

```ts
env: {
  DEVELOPMENT_TOKEN: mode === 'development' && bindings.secret(),
},
```

From `localhost`, `127.0.0.1` or `[::1]` it is a developer (`local-developer`) holding every scope the
application declares, in the organization `development.organizationId` (default `local-development`).
Every other token is verified as usual. It never matches a request to any other host, which is how
the internet reaches a deployed Worker, nor a token shorter than 32 characters, and the comparison
takes the same time however much of the token matches. The host comes from the request's URL, which
a Worker calling through a Service Binding chooses, so what keeps the token off a deployment is the
binding: declared for `cf dev` alone, no build that `cf deploy` uploads has it. Never set
`DEVELOPMENT_TOKEN` on a deployed Worker.

## Token schemes

`tokens.scheme` tells clients how to obtain a token. It changes discovery and documentation, not the
checks above.

| `scheme`                                | Use when                                                                 | Effect                                                                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ type: 'oauth' }` (default)           | Callers get OAuth access tokens from `issuer`.                           | OpenAPI publishes OAuth authorization-code and client-credentials flows; OAuth discovery is served.                                                                                                |
| `{ type: 'bearer', description }`       | The application issues its own tokens, such as a signed visitor session. | Requires `resolve`. OpenAPI publishes an HTTP bearer scheme with your description; no OAuth discovery; a `401` carries a plain `Bearer` challenge. Cannot mount MCP or declare `tokens.resources`. |
| `{ type: 'oauth+bearer', description }` | People use OAuth and machines use workload keys your resolver verifies.  | Requires `resolve`. OpenAPI publishes OAuth authorization code and the bearer scheme as alternatives per operation, from its `actorKinds` (which every published operation must then declare).     |

## OAuth discovery

MCP clients and OAuth-aware HTTP clients find out how to authenticate from the service itself:

- `GET /.well-known/oauth-protected-resource` (and `/mcp` after it) answers
  [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html) metadata: `resource` is
  `tokens.audience` (the first one, when it lists several), `authorization_servers` is
  `[tokens.issuer]`, `scopes_supported` lists the scopes of public operations and transports, and
  `resource_documentation` points at `/openapi.json`.
- A `401` carries `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`,
  including the `basePath` when there is one.

Two options adjust this:

- `tokens.resourceMetadataUrl` overrides the challenge URL: a string, `null` for a plain `Bearer`
  challenge, or `(context) => string | null` to choose per request (for example, one URL for MCP and
  another for REST).
- `tokens.resources` publishes your own resources instead of the inferred one. Each key is an
  absolute path below `/.well-known/oauth-protected-resource`; each value names an `audience`,
  `authorizationServers` and the OAuth `scopes` clients should request, the first two optionally as
  functions of `env`:

  ```ts
  tokens: {
    issuer: 'https://auth.example.com/',
    audience: 'https://api.example.com',
    resources: {
      '/.well-known/oauth-protected-resource/api': {
        audience: (env) => env.API_AUDIENCE,
        authorizationServers: ['https://auth.example.com/'],
        scopes: ['openid', 'offline_access', 'notes:notes:read'],
      },
    },
  },
  ```

  Configured resources answer `GET` only, with `access-control-allow-origin: *`, and replace the
  inferred endpoints. The `401` challenge still names `/.well-known/oauth-protected-resource` unless
  you set `resourceMetadataUrl`, so set it to one of your resources (or key a resource at that exact
  path). `tokens.resources: {}` with `resourceMetadataUrl: null` serves no discovery at all and
  challenges with a plain `Bearer`.

None of these options changes how tokens are verified.

## Machine clients

For service-to-service calls with OAuth, create a dedicated machine client:

- grant it exactly the audience and scopes it needs, bound to one organization (with Auth0, a client
  grant that requires an organization and allows only the intended one);
- remember the grant, not the requested scope string, decides the effective scopes;
- use a separate audience when management authority must stay apart from business reads;
- never replace a person's consent with a machine token.

Between Workers in one account, prefer [native RPC](worker-rpc.md) to tokens.

## Verifying tokens in your own routes

A plain route that must accept the same tokens can use the same verifier:

```ts
import { createTokenAuthorization } from '@arbol-ai/maximus';

const authorize = createTokenAuthorization(app.tokens);

async function exportRoute(request: Request, env: Env, context: RouteContext) {
  const caller = await authorize(request, 'notes:notes:read');
  if (!caller.ok) {
    return context.fail(caller.error);
  }
  // caller.value: { actorId, actorKind, organizationId, scopes, client? }
  // ...
}
```

With a resolver that reads `env`, pass the resolution context as the third argument:
`authorize(request, scope, { env, request, surface: 'http', applicationScopes: [], background })`.
A fourth argument, `'all'`, requires every scope of a list.

`createTokenVerifier({ issuer, audience })` and `projectToken(claims)` expose the two halves of the
default verification for resolvers that extend it.

## Rules

- The organization comes from the principal. Never from input, a header or a subdomain.
- An operation is authorized by its scopes, actor kinds and your handler's checks. Not by its
  effect, its visibility, its description or its path.
- Middleware runs after authentication and cannot replace it.
- A resolver verifies cryptographically and returns a strict principal; it never trusts a claim it
  did not verify.
