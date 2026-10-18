# Migrating from 2.x

Move every `@getarbol/maximus*` dependency to the same 3.x version together.
(`@getarbol/maximus-postgres` is versioned on its own and unaffected.) Signed admission, unsigned
delegation and the service artifact below describe 3.x and 4.x; 5.0 removed them (see
`migration-to-v5.md`).

## Breaking changes in 3.0.0

| Area | 2.x | 3.x | Do |
| --- | --- | --- | --- |
| Issuer | `tokens.issuer` had a built-in default | No default | Set `tokens.issuer` everywhere OAuth tokens are verified or documented. Missing → every OAuth token is 401 and `/openapi.json` is 500. |
| Proof type | `arbol-admission+jwt` | `maximus-admission+jwt` | Release signer and all owners together. |
| OpenAPI extensions | `x-arbol-service-id`, `-publication`, `-publish`, `-input-schema`, `-actor-kinds` | `x-maximus-…` | Update readers of classified documents. |
| Security schemes | `arbolToken`, `arbolHuman`, `arbolMachine` | `oauth2`, `bearer` | Update clients and generators. |
| Service owner | `'arbol'` | `'platform'` | Replace in `service.owner`. |
| `maximus token` | `ARBOL_CLIENT_ID`, `ARBOL_CLIENT_SECRET`, `ARBOL_ISSUER` | `--issuer` (required), `MAXIMUS_CLIENT_ID`, `MAXIMUS_CLIENT_SECRET` | Removed in 4.0: drop it from operator scripts. |

## Notable 3.x additions

- 3.1.0: `@getarbol/maximus/projection`, `callAdmitted`, admission service schemas, `OUTCOME_UNKNOWN`.
- 3.2.0: `checkSchema`, `readSchema`.
- 3.3.0: `INVALID_INPUT` carries `data.issues` everywhere; clients expecting `data: {}` must accept it.
- 3.3.1: plain routes beneath a transport path.
- 3.4.0: `admission.attachments`; `describe` for an internal runtime's agent.
- 3.4.1: `callAdmitted` fixed for real Service Binding stubs; upgrade dispatchers from 3.4.0.
- 3.5.0: runtime-free `@getarbol/maximus/admitted` and `@getarbol/maximus/failures`.
- 3.6.0: `.build()` refuses a missing or non-HTTPS `tokens.issuer` and input codecs outside
  `inputSchema()`.

## Classifying an unclassified (pre-2.13) service

1. `publication: 'private' | 'selected'`.
2. `publish: { rest, mcp }` on every operation (`true` only with the transport declared, never for
   internal operations or in a private service).
3. `actorKinds` on every operation.
4. `api: { resource, verb, id? }` on every published or admitted operation.
5. `service: { kind, owner, publicName?, dependencies?, connections?, roles? }`.
6. `bun --bun maximus check`, then `bun --bun maximus export --allow-dirty --out artifact.json`.

`.build()` names the next operation and rule to fix.

## Unsigned delegation → signed admission

| | Before | After |
| --- | --- | --- |
| Operation | `delegated: { surfaces, actorKinds, clientClasses }` | `admission: { callers, ingresses }`, `actorKinds` |
| Application | `delegation: { authorize(env, grant) }` | `admission: { verification, authorize }` |
| Props | `{ caller: 'gateway', mode: 'delegated' }` | `{ caller: '<dispatcher>', mode: 'admitted' }` |

Same `worker.delegatedEntrypoint`. Unsigned grants are refused once `publication` is set.

## From 1.x

Explicit packages instead of Elysia/Eden; one fluent base with mounted resource modules; opt-in MCP
and telemetry; remove `Function` test shims; check consumers' RPC types against `Service<T>` with a
`never` control; keep Durable Object class names, migration tags and durable keys.

## Verify

Typecheck, tests, dry-run bundle, `maximus check` for classified services, then verify the deployed
Worker (health, OpenAPI, a 401 without token, a real call).
