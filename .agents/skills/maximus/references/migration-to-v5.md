# Migrating to 5.0

The platform Gateway is a proxy to each service's own origin; services call each other over native
RPC. 5.0 removes what nothing calls anymore. TypeScript names each removed option that remains.

## Remove from the application

- `gateway: { audience, issuer, … }`: list the platform audience in `tokens.audience` instead
  (`[OWN, PLATFORM]`); the origin verifies the forwarded token like any other. Move rules that
  `gateway.authorize` applied into context or middleware.
- `originRoutes`: a selected service's origin serves and documents every declared route (as
  `'declared'` did). With `'none'` it now also serves `/`, `/openapi.json` and `/health`; a web app
  that needs `/` sets `http.basePath`.
- `contract`, `admission`, `delegation`.
- `service.kind`, `service.owner`, `service.dependencies`, `service.connections` (keep
  `publicName`, `permissions`, `roles`).
- On operations: `admission`, `delegated`, `resourceSlots`, `execution`.

## Remove from the Worker

- `worker.delegatedEntrypoint` and its export (and the export declared in `cloudflare.config.ts` or
  Wrangler), and bindings with props `mode: 'token' | 'admitted' | 'delegated'`.
- `maximus publish`, `maximus export`, `maximus permissions` steps in CI.

## Imports

- `isResult`: from `@getarbol/maximus` (was `/admitted`).
- Gone: `/admitted` (`callAdmitted`), `/delegation` (everything), `exportServiceContract`,
  `ContractBuild`, `gatewayServes`, `GatewayPolicy`, `GatewayCall`, `OriginRoutes`, and from
  `/projection` `publicName`, `cliCommand`, `restRoute`, `encodeQuery`, `decodeQuery`.
- `originServes(publication, operation, surface)` lost its `originRoutes` argument.
- `authority.admission` is gone; `authority.token` remains.

## OpenAPI

`x-maximus-gateway`, `x-maximus-failures` and `x-maximus-service.kind` are gone; `x-maximus-tokens:
{ issuer, audiences }` names whose tokens the service verifies. The `artifact` projection is gone.
