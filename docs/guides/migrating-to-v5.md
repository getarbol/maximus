# Migrating to 5.0

The platform Gateway is now a plain proxy: it forwards `/v1/<service>/<path>` to each service's own
origin with the caller's token, merges the services' `/openapi.json` documents and generates the SDK,
CLI and MCP tools from them. Services call each other over native RPC. Maximus 5.0 removes what the
earlier designs needed and nothing calls anymore: the delegated entrypoint and the Gateway's token
mode, signed admission and unsigned delegated grants, the service artifact and its publishing, and the
old compiler's fields. Everything else is unchanged.

## Application configuration

Remove these options; TypeScript names each one that remains.

| 4.x                                                          | 5.0                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateway: { audience, issuer, jwksUri?, authorize? }`        | Remove it. List the platform audience in `tokens.audience` beside the service's own (`audience: [OWN, PLATFORM]`): the Gateway forwards the caller's token to the origin, which verifies it like any other. Rules that `gateway.authorize` applied belong in the application's context or middleware.                                                                                                                                             |
| `originRoutes: 'published' \| 'declared' \| 'none'`          | Remove it. A selected service's origin serves and documents every declared route, as `'declared'` did, because the Gateway forwards every call there. With `'none'`, the origin now serves its operations and also `/`, `/openapi.json`, `/openapi.yaml`, `/health` and the OAuth metadata; a web app that needs `/` as a page moves the API below a prefix with `http.basePath`, and the platform lists the service's OpenAPI under that prefix. |
| `contract: { package, registry?, notify?, notifyWorkflow? }` | Remove it, with any `maximus publish` step: the platform fetches the deployed origin's `/openapi.json`.                                                                                                                                                                                                                                                                                                                                           |
| `admission`, `delegation`                                    | Remove them.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `service: { kind, owner, dependencies, connections, … }`     | Keep only `publicName`, `permissions` and `roles`.                                                                                                                                                                                                                                                                                                                                                                                                |

On operations, remove `admission`, `delegated`, `resourceSlots` and `execution`.

## The Worker

`createWorker` no longer returns `delegatedEntrypoint`. Remove its export
(`export const NotesGateway = worker.delegatedEntrypoint`), the export in `cloudflare.config.ts` or
the Wrangler file if it is declared there, and any Service Binding whose props carry
`mode: 'token'`, `'admitted'` or `'delegated'`. Native RPC through `worker.entrypoint` with
`{ caller }` props is unchanged.

`InvocationAuthority` loses `admission`. `authority.token` remains: on a call to the origin,
including one the Gateway forwards, it is the caller's verified access token.

## Imports

| 4.x                                                                                                                       | 5.0                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `isResult` from `@getarbol/maximus/admitted`                                                                              | `isResult` from `@getarbol/maximus`                                                                                                                                |
| `callAdmitted` from `@getarbol/maximus/admitted`                                                                          | Removed. Call native RPC methods on the binding.                                                                                                                   |
| Anything from `@getarbol/maximus/delegation`                                                                              | Removed: admission proofs and keys, `operationContract`, the admission service's schemas, `authorizeDelegatedOperation`, `DelegatedGrant`, the Gateway token mode. |
| `exportServiceContract`, `ContractBuild`                                                                                  | Removed. `createOpenApi(app, { projection: 'origin' })` is the document the origin serves.                                                                         |
| `gatewayServes`, types `GatewayPolicy`, `GatewayCall`, `OriginRoutes`                                                     | Removed.                                                                                                                                                           |
| `publicName`, `cliCommand`, `restRoute`, `encodeQuery`, `decodeQuery`, types `RestRoute`, `RestMethod` from `/projection` | Removed. `mcpToolName`, `kebab`, `snake`, `permissionDescription` and `queryKind` remain.                                                                          |
| `originServes(publication, originRoutes, operation, surface)`                                                             | `originServes(publication, operation, surface)`.                                                                                                                   |

## The CLI

`maximus publish`, `maximus export` and `maximus permissions` are removed, with the `--out`,
`--entrypoint`, `--allow-dirty`, `--package`, `--registry`, `--notify` and `--notify-workflow` flags.
`maximus check` no longer looks for `worker.delegatedEntrypoint` or for
`{ caller, mode: 'admitted' }` bindings, and asks for a service definition only when the application
publishes operations. `check`, `deploy`, `dev`, `types` and `init` are otherwise unchanged.

## The OpenAPI document

- `x-maximus-gateway` and `x-maximus-failures` are gone, and `x-maximus-service` no longer carries
  `kind`. The failure responses of each operation still name every code with its status.
- `x-maximus-tokens: { issuer, audiences }` names whose OAuth access tokens the service verifies (or
  `null` for a service that issues its own bearer tokens). A Gateway that checked
  `x-maximus-gateway.audience` checks that `x-maximus-tokens.audiences` includes the platform audience
  and that `issuer` is the platform's.
- The `artifact` projection is gone; `createOpenApi` takes `'platform'` (the default) or `'origin'`.
- Every other extension the Gateway reads is unchanged, and every `$ref` is local.
