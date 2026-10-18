# Migrating from 2.x

Version 3 renamed every identifier that travels on the wire to neutral names and removed the default
authorization server. Everything else in 3.x is additive. This guide lists the breaking changes, the
additions worth adopting, and how to move an older 2.x service to classification and signed
admission.

Maximus 5.0 removed signed admission, unsigned delegation, the service artifact and
`maximus export`; the parts of this guide about them describe 3.x and 4.x only. See
[Migrating to 5.0](migrating-to-v5.md).

Upgrade all `@getarbol/maximus*` packages together; they are released with one version.
`@getarbol/maximus-postgres` is versioned on its own and is unaffected. Published 2.x releases remain
available and unchanged.

## Breaking changes in 3.0.0

| Area | 2.x | 3.x | What to do |
| --- | --- | --- | --- |
| Token issuer | `tokens.issuer` defaulted to a built-in authorization server. | No default. | Set `tokens.issuer` on every application that verifies or documents OAuth tokens. Without it, OAuth tokens are refused and `/openapi.json` fails. |
| Admission proof type | `typ: arbol-admission+jwt` | `typ: maximus-admission+jwt` | Upgrade the signer and every verifying owner in the same release window: each refuses the other's proofs. |
| Classification extensions | `x-arbol-service-id`, `x-arbol-publication`, `x-arbol-publish`, `x-arbol-input-schema`, `x-arbol-actor-kinds` | `x-maximus-service-id`, `x-maximus-publication`, `x-maximus-publish`, `x-maximus-input-schema`, `x-maximus-actor-kinds` | Update tools that read classified OpenAPI documents. |
| Security scheme names | `arbolToken`; `arbolHuman` and `arbolMachine` for dual authentication | `oauth2`; `bearer` | Update clients or generators that reference scheme names. |
| Service owner | `owner: 'arbol'` | `owner: 'platform'` | Replace the value in `service`. |
| `maximus token` | `ARBOL_CLIENT_ID`, `ARBOL_CLIENT_SECRET`, optional `ARBOL_ISSUER` | `--issuer` (required), `MAXIMUS_CLIENT_ID`, `MAXIMUS_CLIENT_SECRET` | Removed in 4.0: drop it from operator scripts. |

The token verifier is now built on first use, so an application whose `tokens.resolve` handles every
token never contacts an issuer.

## Additions in 3.x

| Version | Addition |
| --- | --- |
| 3.1.0 | `@getarbol/maximus/projection` (public names, REST routes, MCP tool names, CLI commands, query codec); `callAdmitted` and the admission service's native contract; the standard `OUTCOME_UNKNOWN` failure. |
| 3.2.0 | `checkSchema` and `readSchema` for stored, provider and model data. |
| 3.3.0 | `INVALID_INPUT` carries `data.issues` on every transport. Clients that expected `data: {}` must accept the issues. |
| 3.3.1 | A plain route may sit beneath a transport's path. |
| 3.4.0 | Admitted operations declare the input field that names files (`admission.attachments`); `describe` accepts an internal runtime's agent. |
| 3.4.1 | `callAdmitted` calls a Service Binding stub's method directly. Upgrade every dispatcher from 3.4.0, where admitted calls through real bindings failed. |
| 3.5.0 | `@getarbol/maximus/admitted` and `@getarbol/maximus/failures`, runtime-free entries for dispatchers. |
| 3.6.0 | `.build()` refuses a missing or non-HTTPS `tokens.issuer` and input codecs outside `inputSchema()`, both of which used to fail at run time or without a word. |

See the [changelog](../../CHANGELOG.md) for every release.

## Classifying an older 2.x service

Services written before 2.13 are unclassified. They keep working, but cannot export a platform
artifact or accept signed admission. To classify one:

1. Set `publication: 'private'` or `'selected'` on the application.
2. Give every operation `publish: { rest, mcp }`; `true` only where the transport is declared and the
   operation should be public.
3. Give every operation `actorKinds`.
4. Give every published or admitted operation `api: { resource, verb, id? }`.
5. Add `service: { kind, owner, … }` with its dependencies.
6. Run `maximus check` and `maximus export --allow-dirty --out artifact.json` until both are clean.

Each step fails construction with a message naming the operation until it is complete, so you can
work through the errors. See [Service definition and CLI](service-definition-and-cli.md).

## From unsigned delegation to signed admission

| | Unsigned delegation (legacy) | Signed admission |
| --- | --- | --- |
| Operation | `delegated: { surfaces, actorKinds, clientClasses }` | `admission: { callers, ingresses }`, `actorKinds` |
| Application | `delegation: { authorize(env, grant) }` | `admission: { verification(env), authorize(env, admission, input) }` |
| Binding props | `{ caller: 'gateway', mode: 'delegated' }` | `{ caller: '<dispatcher>', mode: 'admitted' }` |
| Credential | An unsigned grant object | A signed proof from the admission service |
| Classification | Unclassified only | Requires `publication` |

Both were served by `worker.delegatedEntrypoint`. Once an application declared `publication`,
unsigned grants were refused, so the dispatcher and the owner moved together. Both are gone in 5.0:
see [Migrating to 5.0](migrating-to-v5.md).

## From 1.x to 2.x

Version 2 replaced Elysia and Eden with native `fetch` routing and split optional capabilities into
packages:

- Import from explicit packages: `@getarbol/maximus` for definitions and HTTP,
  `@getarbol/maximus-workers` for the Worker, `@getarbol/maximus-client` for the client, and opt into
  `@getarbol/maximus-mcp` and the telemetry packages.
- Replace manifests with one fluent base per service and resource modules mounted on it.
- Remove any `Function` workaround test shim; nothing compiles code at runtime.
- Check every consuming Worker's native RPC return types against `Service<T>`, with a `never`
  negative control (see [Testing](testing.md#native-rpc-types)).
- Preserve Durable Object class names, migration tags, connection ids and durable keys. Reorganizing
  code must not reset stored state.

## Upgrade procedure

1. Move every `@getarbol/maximus*` dependency to the same 3.x version.
2. Apply the breaking changes above.
3. Run your typecheck, tests, a dry-run bundle and, for classified services, `maximus check`.
4. Release signers and owners of admission proofs together.
5. Verify the deployed Worker; see [Deploying](deploying.md#verify-the-deployment).
