# Authentication and scopes

Every call to the API and to the MCP server carries a bearer token, or, behind Cloudflare Access, the
token Access adds. This guide covers how Maximus verifies it and turns it into the caller, how scopes decide
which routes a caller may run, Auth0 and Cloudflare Access, the development token, tokens your application
verifies itself, OAuth discovery and rate limits. Read it before your first deployment, and whenever you
connect an authorization server.

## Configure the token issuer

By default, the API accepts OAuth access tokens from one authorization server. Name it in `tokens`, in
`maximus()` in `vite.config.ts`:

```ts
import { maximus } from '@arbol-ai/maximus/vite';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [
    maximus({
      origin: 'https://notes.example.com',
      tokens: { issuer: 'https://auth.example.com/' },
      compatibilityDate: '2026-10-27',
    }),
  ],
});
```

A token is accepted when one of the issuer's keys signed it with an algorithm `tokens.algorithms` allows,
its `iss` is `tokens.issuer`, its `aud` names one of the audiences, and it carries `exp` and `sub`. An
expired token is refused, with five seconds of tolerance for clocks that disagree, and so is a token whose
`typ` header names another type than a plain `JWT` or an access token, `at+jwt` (RFC 9068): the issuer's
keys signed it for another use. A token without a `typ` header is a plain JWT. The options of `tokens`:

| Option                  | Default                            | Meaning                                                                                                                                                      |
| ----------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `issuer`                | None                               | The authorization server, an HTTPS URL, or the issuers it answers to, the canonical first. Required, except under the `bearer` [scheme](#token-schemes).     |
| `audience`              | `origin`                           | The audience a token must carry, or a list of audiences, any one of which it may carry. The first is the resource [OAuth discovery](#oauth-discovery) names. |
| `jwksUri`               | `.well-known/jwks.json`            | Where the issuer publishes its signing keys, resolved against `issuer`. HTTPS only.                                                                          |
| `algorithms`            | `['RS256']`                        | The algorithms the issuer signs with: `RS256`, `RS384`, `RS512`, `PS256`, `PS384`, `PS512`, `ES256`, `ES384`, `ES512` or `EdDSA`.                            |
| `authorizationEndpoint` | `authorize`                        | The authorization endpoint the OpenAPI document publishes for the authorization code flow, resolved against `issuer`.                                        |
| `tokenEndpoint`         | `oauth/token`                      | The token endpoint the OpenAPI document publishes, resolved against `issuer`.                                                                                |
| `claims`                | The standard claims                | Where the token carries the organization, the scopes, the client and a person's permissions. See [From token to caller](#from-token-to-caller).              |
| `development`           | `{ binding: 'DEVELOPMENT_TOKEN' }` | The token `vp dev` accepts from localhost, or `false` for none. See [The development token](#the-development-token).                                         |
| `scheme`                | `{ type: 'oauth' }`                | How callers obtain tokens. See [Token schemes](#token-schemes).                                                                                              |
| `source`                | `'authorization'`                  | Where requests present their token: the bearer token of `authorization`, or `'cloudflare-access'`. See [Cloudflare Access](#cloudflare-access).              |
| `access`                | None                               | What Cloudflare Access tokens grant: the scopes of people and of each service token, and the organization. See [Cloudflare Access](#cloudflare-access).      |

The defaults of `jwksUri`, `authorizationEndpoint` and `tokenEndpoint` are Auth0's paths. For another
authorization server, copy them from its metadata (`jwks_uri`, `authorization_endpoint` and
`token_endpoint`). Maximus verifies tokens with the first; the OpenAPI document publishes the other two as
the URLs of the OAuth flows.

A service behind a gateway that also accepts the tokens issued for the gateway lists both audiences, its
own first:

```ts
tokens: {
  issuer: 'https://auth.example.com/',
  audience: ['https://notes.example.com', 'https://api.example.com'],
},
```

A token for any other audience is refused. An authorization server that answers to several issuer
identifiers, such as an Auth0 tenant with a custom domain, lists them in `issuer`, the canonical one first:
a token may name any of them as its `iss`, and the first is the one OAuth discovery names and the JWKS and
the endpoints resolve against.

A configuration that could never verify a token is refused when the Worker starts, and in every test that
loads it: a missing `issuer` with `tokens.issuer is required to verify or document OAuth access tokens.`,
and likewise an empty or repeated audience or issuer, an algorithm outside the list, and an issuer or
endpoint that is not HTTPS.

## From token to caller

A verified token becomes the call's principal: the `actorId`, `actorKind` and `organizationId` every
handler receives (see [Callers](../concepts.md#callers)), with the scopes the token grants. Maximus reads
the standard claims of an OAuth access token (RFC 9068) and Auth0's conventions:

| Claim                   | Option in `claims` | Becomes                                                                                                    |
| ----------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `sub`                   |                    | `actorId`, 1 to 255 characters.                                                                            |
| `org_id`                | `organization`     | `organizationId`. Required: 1 to 128 letters, digits, `_` and `-`, starting with a letter or a digit.      |
| `azp`, else `client_id` | `client`           | The OAuth client the token was issued to. Optional; when a token carries both claims, they must be equal.  |
| `scope`                 | `scopes`           | The granted scopes, as a space-separated string or a list. A token without the claim grants none.          |
| `permissions`           | `permissions`      | What a person may do, as a string or a list. A person holds only the granted scopes this claim also lists. |

The subject decides who acts. A token whose subject is `<client>@clients`, where `<client>` is the
token's own client, is a machine: its `actorKind` is `service`, and it holds every scope it is granted. Any
other subject is a person, `actorKind: 'user'`, who holds only the granted scopes their `permissions` also
list, and none when the token lists no permissions. A subject that ends in `@clients` but names another
client is refused, and so is a token of the client credentials grant, `gty: client-credentials` as Auth0
marks it, whose subject is not a machine's: such a token never passes as a person.

A person's scopes must appear in both claims because the client chooses which scopes it requests. An
authorization server that grants whatever scope a client asks for would otherwise let any member of an
organization give themselves an administrator's scope. Auth0 lists each person's permissions in the
token when RBAC and **Add Permissions in the Access Token** are enabled on the API.

When your authorization server names the claims differently, map them with `tokens.claims`. Each entry is
a claim's name, or a dotted path into an object claim; a claim whose own name has dots, such as
`https://example.com/org_id`, is read as it is named:

```ts
tokens: {
  issuer: 'https://idp.example.com/',
  claims: { organization: 'tenant.id', permissions: 'roles' },
},
```

Two entries change a rule rather than a name:

- `permissions: false` trusts the granted scopes alone. Set it only for an authorization server that grants
  each person no more than they may hold, as Okta does when each scope's access policy admits only the
  groups that may hold it; never for one that grants whatever a client requests.
- `machineSubject: '{client}'` makes a token whose subject equals its client id a machine, as RFC 9068
  recommends and as Okta and WorkOS issue client-credentials tokens. Set it only when the authorization
  server assigns every client id, so that no client id can equal a person's subject.

| Authorization server  | `claims`                                                                           |
| --------------------- | ---------------------------------------------------------------------------------- |
| Auth0                 | None. See [Auth0](#auth0).                                                         |
| Okta                  | `{ scopes: 'scp', client: 'cid', permissions: false, machineSubject: '{client}' }` |
| WorkOS session tokens | `{ scopes: 'permissions' }`                                                        |

An authorization server that issues no organization claim needs one added, under `org_id` or the name
`claims.organization` gives it. A claim Maximus cannot read, such as a `scope` that is neither a string
nor a list of strings, refuses the token.

A token that names its client gives each call an `authority`: the surface that admitted it (`http` or
`mcp`), the granted scopes, the client, of class `human` for a person's token and `machine` for a
machine's, and the verified token itself. A token that names no client still runs the routes its scopes
admit, but its calls carry no `authority`, and routes with
[conditional scopes](#scopes-the-handler-checks) refuse them.
[Context and middleware](middleware-and-context.md#what-a-handler-receives) shows what a handler receives.

## Auth0

`auth0()` from `@arbol-ai/maximus/vite` states the token options of an API whose access tokens Auth0
issues:

```ts
import { auth0, maximus } from '@arbol-ai/maximus/vite';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [
    maximus({
      origin: 'https://notes.example.com',
      tokens: auth0({ domain: 'acme.us.auth0.com', audience: 'https://notes.example.com' }),
      compatibilityDate: '2026-10-27',
    }),
  ],
});
```

`domain` is the tenant's domain, and `audience` the identifier of the API in Auth0, which its tokens carry
as their audience. The preset returns plain options: the issuer `https://acme.us.auth0.com/`, with the
trailing slash Auth0 writes in `iss`, the audience, and `algorithms: ['RS256']`; the JWKS, the endpoints
and the claims keep their defaults, which are Auth0's. Set `algorithms` to the API's signing algorithm when
it is `RS512` or `PS256`. `HS256` is refused, since a secret signs those tokens and no JWKS publishes it, and
so is a domain with a scheme, a port or a path. Spread the preset to add what it leaves out, such as
`{ ...auth0({ domain, audience }), development: false }`.

A tenant with a custom domain writes in `iss` the domain a token was requested from. List both domains,
the canonical one first, and tokens from either are accepted:

```ts
tokens: auth0({ domain: ['login.acme.com', 'acme.us.auth0.com'], audience: 'https://notes.example.com' }),
```

The API's **JSON Web Token (JWT) Profile** chooses the dialect of its access tokens, and Maximus reads both:

| What              | Auth0 profile                                               | RFC 9068 profile            |
| ----------------- | ----------------------------------------------------------- | --------------------------- |
| The `typ` header  | `JWT`                                                       | `at+jwt`                    |
| The client        | `azp`                                                       | `client_id`                 |
| A machine's token | `sub` is `<client>@clients`, with `gty: client-credentials` | `sub` is `<client>@clients` |

Both carry the granted scopes in `scope` and the organization in `org_id`. A person holds only the granted
scopes their `permissions` also list, which Auth0 adds when **Enable RBAC** and **Add Permissions in the
Access Token** are on in the API's settings: turn both on. The `aud` of a token that also serves OpenID
Connect lists `https://<domain>/userinfo` beside the API's identifier, which is the one that must be there.
For the organization, sign people in to an [Organization](https://auth0.com/docs/manage-users/organizations),
and issue machine tokens for one with
[organizations for machine-to-machine applications](https://auth0.com/docs/manage-users/organizations/organizations-for-m2m-applications):
a token without `org_id` is refused. A token of the client credentials grant whose subject is not
`<client>@clients` of its own client is refused, so it never passes as a person.

## Refused calls

Admission happens after the route is matched, so a path no route answers is `404` before any token is
read. Then every call is refused, before its body is read and before any of your code runs, when:

- it has no `authorization: Bearer <token>` header;
- it carries an `x-api-key` header, whatever its bearer token;
- its token is longer than 16 384 characters;
- its token is not shaped like a JWT, three base64url segments separated by dots, unless `auth.ts`
  [resolves tokens](#tokens-your-application-verifies) itself;
- its signature, issuer, audience, expiry or claims fail the checks above.

Each of these answers `401` with the failure `UNAUTHORIZED` and a `www-authenticate` challenge (see
[OAuth discovery](#oauth-discovery)). A valid token that lacks the route's scope answers `403` with
`FORBIDDEN`. [Standard failures](../reference/standard-failures.md) lists both. Behind
[Cloudflare Access](#cloudflare-access), the token is the one of the `cf-access-jwt-assertion` header
instead, and a write another site's page sends is refused too.

## Scopes

A scope is a permission a token must hold for the call to run: `<namespace>:<resource>:<action>`, where
the namespace is the service's (its `name`, unless `namespace` in `maximus()` says otherwise). A route that
declares no scope takes one from its path and effect:

| File                                 | Effect   | Scope                        |
| ------------------------------------ | -------- | ---------------------------- |
| `routes/v1/notes.post.ts`            | `write`  | `notes:notes:write`          |
| `routes/v1/notes/[noteId].get.ts`    | `read`   | `notes:notes:read`           |
| `routes/v1/notes/[noteId].delete.ts` | `delete` | `notes:notes:write`          |
| `mcp/tools/summarize-notes.ts`       | `read`   | `notes:summarize-notes:read` |

The resource is the first fixed segment after the version, in kebab-case, and the action is `read` for a
read and `write` for anything else. A tool of `mcp/tools/` takes its file's name as the resource. A route
whose path has no fixed segment after the version must declare its scope.

Declare `scope` when the derived one is not the permission you mean, or when several scopes admit the
call:

```ts
scope: 'notes:notes:manage',                       // one scope
scope: ['notes:notes:read', 'notes:notes:write'],  // any one of them: a write grant also reads
scope: ['notes:notes:read', 'notes:audit:read'],
scopeMatch: 'all',                                 // every one of them
```

Every scope is lowercase, starts with the service's namespace and has at least three segments. A route
whose scope breaks the rule is refused when the Worker starts. The OpenAPI document gives each scope of a
list as an alternative requirement of the operation's `security`, and a `scopeMatch: 'all'` list as one
requirement.

The MCP server has a scope of its own, `<namespace>:mcp:use`: a token needs it for every MCP request,
besides the scope of each tool it calls. See [MCP](mcp.md#who-may-call-a-tool).

### Scopes the handler checks

Some permissions depend on what a call touches rather than on the route. Say notes carry an `archived`
flag: anyone in the organization may read a note, but only an administrator may read an archived one.
Declare such scopes in `conditionalScopes`, and check them in the handler against `authority.scopes`:

```ts
// routes/v1/notes/[noteId].get.ts
import { defineHandler, UuidSchema } from '@arbol-ai/maximus';

import { NoteSchema } from '../../../src/notes.ts';

export default defineHandler(
  async ({ input, notes, authority, fail }) => {
    const note = await notes.get(input.noteId);
    if (!note) {
      return fail('NOTE_NOT_FOUND');
    }
    if (note.archived && !authority?.scopes.includes('notes:archive:read')) {
      return fail('FORBIDDEN');
    }
    return note;
  },
  {
    description: 'Read one note of the organization by its id.',
    input: { noteId: UuidSchema },
    output: NoteSchema,
    failures: ['NOTE_NOT_FOUND'],
    conditionalScopes: ['notes:archive:read'],
  }
);
```

Conditional scopes are namespaced like any other, listed once and distinct from the route's own; a route
that breaks the rule is refused when the Worker starts:
`Operation "<name>": conditional scopes require unique namespaced declarations distinct from the admission scope.`
The OpenAPI document publishes them in `x-conditional-scopes`. A route that declares them fails closed
without an `authority` to check: a call over [Worker RPC](worker-rpc.md), and a call whose token names no
client, answer `FORBIDDEN` before the context is prepared.

### Who may call: actorKinds

`actorKinds: ['user']` admits people only, and `actorKinds: ['service']` machines only, whatever their
scopes. A caller of another kind is refused with `FORBIDDEN` on every transport, and MCP does not list
the tool to it.

### Internal routes

`visibility: 'internal'` keeps a route for the service's own staff out of the public OpenAPI document and
out of the `scopes_supported` of OAuth discovery. The route is still served and still requires its scope:
give it one that only a staff role holds. Hiding a route never authorizes it, and neither does its
effect, its description, its MCP annotations or an obscure path.

## The development token

Locally, a development token stands in for an access token, so a project runs without an authorization
server. `bun create maximus` writes a random one into `.dev.vars`, which Git ignores:

```text
DEVELOPMENT_TOKEN=3f6c…
```

Under `vp dev`, `maximus()` declares the secret binding `DEVELOPMENT_TOKEN` and accepts its value as a
bearer token when the request's host is `localhost`, `127.0.0.1` or `[::1]` and the value has at least
32 characters. `vp test` prepares the project as `vp dev` does, so tests call the API with a token of
their own the same way (see [Testing](testing.md)). Maximus compares digests of the two values, so the
comparison takes the same time however much of the token matches.

The token signs you in as the person `local-developer` of the organization `local-development`, who holds
every scope the service declares: each route's and tool's scopes, their conditional scopes and, when the
Worker serves MCP, `<namespace>:mcp:use`. Its client is `local-development`, so handlers receive an
`authority` with all of those scopes. Every other token is verified as usual.

No build or preview declares the binding or accepts the token: they are production, whatever their mode.
That is what keeps it off a deployed Worker; the host check alone would not, since a Worker that calls
this one through a Service Binding chooses the request's URL. A project that declares the binding in
`env` itself is refused:
`DEVELOPMENT_TOKEN is the development token: Maximus declares it under vp dev alone, so no deployed Worker carries it.`

`tokens.development` renames the binding or moves the developer to another organization, and `false`
accepts no development token at all:

```ts
tokens: {
  issuer: 'https://auth.example.com/',
  development: { binding: 'LOCAL_TOKEN', organizationId: 'org_1234567890abcdef' },
},
```

## OAuth discovery

MCP clients and other OAuth clients find out how to obtain a token from the service itself. Without a
token, they read the challenge of the `401`:

```text
www-authenticate: Bearer resource_metadata="https://notes.example.com/api/.well-known/oauth-protected-resource"
```

The URL always names the configured `origin`, whatever host the request named. It answers, without a
token and with `access-control-allow-origin: *`, the protected resource metadata of
[RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html):

```json
{
  "resource": "https://notes.example.com",
  "resource_name": "notes",
  "authorization_servers": ["https://auth.example.com/"],
  "bearer_methods_supported": ["header"],
  "scopes_supported": ["notes:notes:write", "notes:notes:read", "notes:mcp:use"],
  "resource_documentation": "https://notes.example.com/api/openapi.json"
}
```

`resource` is the first audience and `resource_name` the service's `title`. `scopes_supported` lists the
scopes of the routes and tools a client can reach, leaving out internal ones, and `<namespace>:mcp:use`
when the Worker serves MCP. `/api/.well-known/oauth-protected-resource/mcp` answers the same document.

`auth.ts` changes what discovery publishes, never how tokens are verified:

- `resourceMetadataUrl` sets the URL the challenge names: a URL, `null` for a plain `Bearer` challenge,
  or a function of the request that chooses one of them per call. Its argument holds `env`, `request`
  and `surface`, `http` or `mcp`.
- `resources` publishes resources of your own instead of the inferred one. Each key is an absolute path
  below `/.well-known/oauth-protected-resource`, outside the API's base path; each value names the
  `audience` and `authorizationServers` a client should use, each a value or a function of `env`, and the
  `scopes` it should request.

```ts
// auth.ts
import { defineAuth } from '@arbol-ai/maximus';

export default defineAuth({
  resources: {
    '/.well-known/oauth-protected-resource/notes': {
      audience: 'https://notes.example.com',
      authorizationServers: ['https://auth.example.com/'],
      scopes: ['openid', 'offline_access', 'notes:notes:read', 'notes:mcp:use'],
    },
  },
  resourceMetadataUrl: 'https://notes.example.com/.well-known/oauth-protected-resource/notes',
});
```

Configured resources replace the inferred documents, which then answer `404`. Each answers `GET` alone,
with `access-control-allow-origin: *`, and a value that is not an HTTPS identifier, an issuer with a query
or a malformed scope answers `500` instead of a partial document. Since the inferred document is gone, a
`401` would point at nothing: `resources` without `resourceMetadataUrl` is refused with
`tokens.resources requires tokens.resourceMetadataUrl: name the metadata a 401 challenge points at.`
`resources: {}` publishes no discovery at all, and challenges with a plain `Bearer`.

## Tokens your application verifies

Some callers present credentials no OAuth issuer signs: keys your service issues to machines, sessions
your application signs. Verify them in `auth.ts`, at the project's root, whose default export is
`defineAuth({ resolve })`. `resolve` receives the bearer token and returns the caller, or a failure:

```ts
// auth.ts
import { defineAuth, err, OrganizationIdSchema, standardErrors, t } from '@arbol-ai/maximus';
import { checkSchema } from '@arbol-ai/maximus/schemas';

/** A service key as the console stores it, under the SHA-256 digest of the key. */
const ServiceKeySchema = t.Object(
  {
    clientId: t.String({ minLength: 1, maxLength: 255 }),
    organizationId: OrganizationIdSchema,
    scopes: t.Array(t.String(), { maxItems: 100 }),
  },
  { additionalProperties: false }
);

/** The hex SHA-256 digest of a key: what the store is keyed by, never the key itself. */
async function digest(key: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export default defineAuth({
  async resolve(token, context) {
    const stored = await context?.env.SERVICE_KEYS.get(await digest(token), 'json');
    const key = checkSchema(ServiceKeySchema, stored);
    if (!key.success) {
      return err(standardErrors.unauthorized.create());
    }
    return {
      actorId: key.data.clientId,
      actorKind: 'service',
      organizationId: key.data.organizationId,
      scopes: key.data.scopes,
      client: { id: key.data.clientId, class: 'machine' },
    };
  },
});
```

with the token scheme and the store in `vite.config.ts`:

```ts
maximus({
  origin: 'https://reports.example.com',
  tokens: { scheme: { type: 'bearer', description: 'A service key issued in the reports console.' } },
  env: { SERVICE_KEYS: bindings.kv() },
  compatibilityDate: '2026-10-27',
}),
```

Proving the credential genuine is the resolver's job, and so is reading what it stored strictly: look a
random key up by its digest, check a signature with `crypto.subtle`, read a stored record through its
schema. Never take a caller's identity from a request header or body. Then Maximus:

- answers `403` when the resolver's failure is `FORBIDDEN`, and `401` for any other failure and when it
  throws. The resolver's own failure and its error never reach the caller;
- checks the principal strictly: `actorId` (1 to 255 characters), `actorKind`, `organizationId`,
  `scopes` (at most 1000) and an optional `client` whose class is `human`, `machine` or `dcr`, and nothing
  else. A `machine` client goes with `actorKind: 'service'` and, except under `oauth+bearer`, with an
  `actorId` that is its client id or `<client id>@clients`. Anything else answers `401`;
- checks the route's scopes against `scopes`, as for any token.

`resolve` receives every bearer token but the development token, and the issuer's OAuth tokens are not
verified unless it verifies them. Its second argument holds the request's `env`, the `request`, its
`surface` and `applicationScopes`, the scopes the service declares, which a resolver may map verified
grants onto but never treats as a grant. Keep nothing of it between requests.

A principal without a `client` makes calls without an `authority`, which routes with conditional scopes
refuse. `defineAuth` takes `resolve`, `resources` and `resourceMetadataUrl` alone; every other token
setting stays in `vite.config.ts`, and `defineAuth` refuses one rather than let it override the
configuration, naming it:
`auth.ts states how tokens are verified in code; configure issuer, audience in vite.config.ts.`

## Token schemes

`tokens.scheme` says how callers obtain their tokens, which the OpenAPI document and discovery publish:

| `scheme`                                | Callers present                                                     | Requires                                             | Publishes                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `{ type: 'oauth' }`, the default        | OAuth access tokens from `issuer`.                                  | `issuer`                                             | The authorization code and client credentials flows, and OAuth discovery.                                    |
| `{ type: 'bearer', description }`       | Tokens the application issues and verifies.                         | `resolve`                                            | An HTTP bearer scheme with `description`. No discovery: a `401` challenges with a plain `Bearer`.            |
| `{ type: 'oauth+bearer', description }` | OAuth access tokens for people, the application's own for machines. | `issuer`, `resolve`, and `actorKinds` on every route | The authorization code flow on routes people call, the bearer scheme on routes machines call, and discovery. |

A Worker whose scheme it cannot serve does not start: `bearer` or `oauth+bearer` without `resolve` is
refused with `An application bearer token scheme requires tokens.resolve to verify the token.`, and
`bearer` with an MCP server with
`The MCP transport needs OAuth discovery; it cannot serve a bearer token scheme.` Under `bearer`, a call's
`authority` carries no token.

Under `oauth+bearer`, `resolve` receives the people's OAuth access tokens too. Verify them with
`createTokenVerifier({ issuer, audience })`, which checks the signature and the claims and throws on any
mismatch, and `projectToken(claims)`, which maps the claims to a principal as described above: they are
the two halves of what Maximus applies without `auth.ts`. Every route must name its `actorKinds`, which
decide the scheme the OpenAPI document publishes for it; a route that names none is refused with
`Operation "<name>": dual authentication requires explicit actor eligibility.`

## Cloudflare Access

[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/) signs people and
service tokens in at Cloudflare's edge, before a request reaches the Worker, and sets the application
token, a JWT that Access signs, in the `cf-access-jwt-assertion` header of each request it lets through.
`cloudflareAccess()` from `@arbol-ai/maximus/vite` makes that token the one the API admits:

```ts
import { cloudflareAccess, maximus } from '@arbol-ai/maximus/vite';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [
    maximus({
      origin: 'https://notes.example.com',
      tokens: cloudflareAccess({
        team: 'acme',
        aud: '4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2',
        organizationId: 'org_acme',
        scopes: {
          people: ['notes:notes:read', 'notes:notes:write'],
          services: { '88bf3b6d86161464f6509f7219099e57.access': ['notes:notes:read'] },
        },
      }),
      compatibilityDate: '2026-10-27',
    }),
  ],
});
```

`team` is the Zero Trust team name, `acme` for `acme.cloudflareaccess.com`, and `aud` the Application
Audience (AUD) tag of the self-hosted Access application that protects the origin, from its overview in
the dashboard. The preset returns plain options: `source: 'cloudflare-access'`, the team's domain as the
issuer, its keys at `/cdn-cgi/access/certs` as `jwksUri`, the AUD tag as the audience, `RS256`, and
`access`, what callers hold.

### What an Access token grants

Access decides who reaches the application, but its tokens carry no scope, so `tokens.access` states them:

| Token             | Recognized by                         | `actorId`                     | `actorKind` | Client                   | Scopes                                  |
| ----------------- | ------------------------------------- | ----------------------------- | ----------- | ------------------------ | --------------------------------------- |
| A person's        | A `sub`, and no `common_name`         | `sub`, the person's Access id | `user`      | The AUD tag, `human`     | `people`                                |
| A service token's | An empty `sub`, and its `common_name` | `common_name`, its client id  | `service`   | Its client id, `machine` | What `services` lists for its client id |

A token of any other shape is refused with `401`: one whose `type` is not `app`, such as an Access
organization token, and one with both a `sub` and a `common_name`, or neither. A person's email is never
their `actorId`. A service token reaches the application when one of its Access policies admits it with
the **Service Auth** action; list its client id, which ends in `.access`, under `services`. One that
`services` does not list holds no scope, so every route refuses it with `403`.

Every caller acts in `access.organizationId`, which suits an application of one tenant. For several, read
the organization from a claim of the token, such as a custom OIDC claim of the identity provider that
Access passes on under `custom`, named in `claims.organization`:

```ts
tokens: {
  ...cloudflareAccess({
    team: 'acme',
    aud: '4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2',
    scopes: { people: ['notes:notes:read'] },
  }),
  claims: { organization: 'custom.org_id' },
},
```

A token without the claim, or whose claim is not an organization id, is refused with `401`. A policy that
names the organization both ways, or neither, is refused when the Worker starts.

### What is verified

A Worker cannot assume that Access stands in front of it: a request reaches it around Access at its
`workers.dev` and preview URLs, at a path the Access application does not cover, and through a Service
Binding, and any client can send a `cf-access-jwt-assertion` header. So every token is verified: signed by
one of the team's keys, issued by the team, for the application's AUD tag, so that a token another Access
application of the team issued is refused, and not expired. The token is read from that header alone:
never from `authorization`, never from the `CF_Authorization` cookie, which not every request carries, and
never from a header Access adds unsigned, such as `cf-access-authenticated-user-email`.

A production build also pins the Worker to its `origin`: a request for any other host, such as its
`workers.dev` URL, answers `404` before any middleware, page or route runs. `vp dev` serves `localhost` and
is not pinned, and there, as in tests, the [development token](#the-development-token) signs in as a bearer
token, as it does without Access.

### What changes behind Access

- No OAuth discovery is served: `/.well-known/oauth-protected-resource` answers `404`, and a `401`
  challenges with a plain `Bearer`.
- The OpenAPI document describes the headers of an Access service token, `CF-Access-Client-Id` and
  `CF-Access-Client-Secret`, as two `apiKey` schemes that every operation requires together. A client sends
  both, and Access checks them at the edge and forwards the request with the service token's application
  token. People sign in to Access in a browser.
- A person's Access session lives in a cookie, which a browser also attaches to the requests other sites'
  pages send. So a call with any method but `GET`, `HEAD` and `OPTIONS` that carries
  `sec-fetch-site: cross-site`, or an `origin` other than its own, answers `403` with `FORBIDDEN` before its
  token is read. A web app on the same origin, and clients that are no browser, are unaffected.
- `authority.token` is absent: operations never receive the Access token. Call the Workers of your account
  over [Worker RPC](worker-rpc.md).
- The Worker serves no MCP, whose clients sign in through OAuth discovery. `maximus prepare` refuses a
  project whose routes or `mcp/` folder declare MCP, and a Worker that mounts `mcp()` does not start.
- A web app's content security policy admits its own origin alone: Access signs people in at the edge, so
  the pages never call the team's domain.

Without `tokens.access`, `auth.ts` verifies Access tokens itself, for scopes the configuration cannot state,
such as ones a person's groups decide. `resolve` then receives the token of `cf-access-jwt-assertion`:
`createTokenVerifier`, given the team's issuer, keys and AUD tag, verifies it as Maximus does, and
`projectAccessToken`, given an `access` of the resolver's choosing, maps its claims as the table above. When
the Worker starts, a policy under `cloudflare-access` is refused without either of them, and with scopes
outside the service's namespace or an option only OAuth uses, such as `scheme`;
[Configuration](../reference/configuration.md#refusals) quotes each message.

## Rate limits

A [Workers rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
limits how often each caller calls the API and the MCP server. Declare the binding in `env` and name it
in `rateLimit`:

```ts
import { maximus } from '@arbol-ai/maximus/vite';
import { bindings } from 'cf/config';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [
    maximus({
      origin: 'https://notes.example.com',
      tokens: { issuer: 'https://auth.example.com/' },
      env: {
        NOTES: bindings.kv(),
        API_LIMIT: bindings.rateLimit({ namespace: '1001', simple: { limit: 100, period: 60 } }),
      },
      rateLimit: { binding: 'API_LIMIT' },
      compatibilityDate: '2026-10-27',
    }),
  ],
});
```

A `binding` that names no binding of `env` is a type error. Each call is checked after its token is
admitted and before its body is read, under a key that is the SHA-256 digest of its organization and its
actor, so the limit applies per caller and the key carries neither identifier. A call over the limit
answers `429` with `RATE_LIMITED`, which is retryable, and `Retry-After: 60`, or the seconds
`rateLimit.retryAfter` sets. A binding missing from the Worker's `env`, or one that fails, answers `500`
with `INTERNAL_ERROR`, and the route does not run.

Each MCP request is one call, and so is each message of a JSON-RPC batch (see [MCP](mcp.md#limits)).
Requests that need no token, such as discovery, the health check and pages, are not limited, and neither
are calls over [Worker RPC](worker-rpc.md), which carry no token.

## Rules

- The organization comes from the verified token, or, for an application of one tenant behind Cloudflare
  Access, from `tokens.access.organizationId`. Never from input, a header or a subdomain.
- A route is authorized by its scopes, its actor kinds and your handler's checks of conditional scopes.
  Never by its effect, its visibility, its description, its MCP annotations or its path.
- Request middleware runs before admission and cannot admit a caller; see
  [Context and middleware](middleware-and-context.md).
- A resolver verifies every credential cryptographically and returns a strict principal; it never trusts
  a claim it did not verify.
- Between Workers of one account, prefer [Worker RPC](worker-rpc.md) to tokens. Between services that
  must verify the original caller, pass the caller's own token, `authority.token`, and let the other
  service verify it again.
