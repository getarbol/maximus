# Changelog

Notable changes to Maximus, newest first. Since 8.0.0, `@arbol-ai/maximus` and
`create-maximus` are released together at one version; from 7.0.0 to 7.4.0, Maximus was the one package
`@arbol-ai/maximus`. The entries before 7.0.0 come from the framework's earlier private repository, where
every `@getarbol/maximus*` package shared the version shown unless an entry says otherwise and
`@getarbol/maximus-postgres` was versioned on its own; that history begins with 2.2.2. Dates are the dates
of the release commits.

## 8.0.0 (2026-10-27)

A Maximus service is a project configured by one file, `vite.config.ts`, whose routes are files: each
declares its contract once and is served over HTTP with OpenAPI, to MCP clients when it says so, and to
other Workers over native RPC. [Upgrading to 8.0](docs/upgrading-to-8.md) moves a 7.x service setting by
setting.

Breaking:

- A handler, context or middleware no longer answers the failures only routing and admission answer
  (`NOT_FOUND`, `HTTP_METHOD_NOT_ALLOWED`, `UNAUTHORIZED`), nor a body's (`REQUEST_TOO_LARGE`,
  `UNSUPPORTED_MEDIA_TYPE`) unless a byte body's `read()` answered it: `fail` does not take them, and one
  answered anyway is `INTERNAL_ERROR`. The OpenAPI document's `Failure` and `FailureResponse` components
  give way to one component per code.

- `maximus()` from the new `@arbol-ai/maximus/vite` states the application and its Worker in
  `vite.config.ts`, with Cloudflare's own names for the Worker's settings, and composes Cloudflare's Vite
  plugin. Gone: `maximus.config.ts` and `defineConfig` and `cloudflare.config.ts`, both of which the plugin
  refuses to find;
  the `src/application.ts` and `src/worker.ts` entries; the service starter and `maximus init --layout`;
  route modules that export `GET` or a route factory, `defineRoute` and `.maximus/routes.ts`; middleware
  modules that export a bare function and the `defineRequestMiddleware` alias; `readWebhookBody`;
  `sameSchema`; and the migration guides of earlier majors.
- The `@arbol-ai/maximus/client` entry is removed: `createClient` and its types (`Envelope`,
  `ClientOptions`, `ClientFailure`, `CallOptions`, `BinaryCallOptions`, `AppClientContract`,
  `ClientManifest`, `ResponseMode`, `OperationName`, `ReadOperationName`, `OperationInput`,
  `OperationOutput`). Call a service over HTTP with `fetch` and the caller's token, typed by its routes'
  schemas, or over native RPC between Workers of one account.
- Development is `vp dev`: every build and preview is a production build, whatever its Vite mode, so the
  development token, `.dev` modules and the forwarding of Vite's modules never reach a deployed Worker.
- A service fails when it starts, with a `TypeError` that names the rule, for what used to pass and fail
  later: under `tokens.scheme` `oauth+bearer`, an operation that names no `actorKinds`; a schema reference
  that names no single definition (both answered 500 to the first request for the OpenAPI document); an
  application name that is not a lowercase kebab-case word of 2 to 64 characters, an operation name over
  100 characters, and an error code that is not uppercase words joined by underscores (analytics dropped
  every event of such a service); a `DELETE` route that declares `effect: 'read'`; and, from code that
  TypeScript does not check, a `telemetry` switch that is neither a boolean nor a function (`'false'` left
  telemetry on) or an observer that is not an object of functions (which failed every call it observed).
- A domain failure that a context, a derive or middleware answers, and that the operation does not declare,
  is answered as `INTERNAL_ERROR` and reported, as one its handler answers always was.
- An MCP JSON-RPC batch is admitted whole: every message passes the rate limit as a request of its own
  before any of them runs, a ping or a listing as much as a tool call, and a batch over the limit answers
  `429` with the `RATE_LIMITED` failure, none of it run. The JSON-RPC error `-32000` is gone. A custom
  transport's `TransportContext` carries `admitCarried`, `refused` and `body` in place of `admitRequest`
  and `bodyBytes`.
- Input decoding refuses an object with its own `__proto__` key, at any depth, and a query field named
  `__proto__`, as `INVALID_INPUT` on HTTP, MCP and RPC and in `checkSchema`. Only a schema mismatch or a
  `SchemaValidationError` refuses input: any other error an input codec throws is the server's, answered as
  `INTERNAL_ERROR` and reported, and `decodeInput` and `checkSchema` throw it.
- `analytics()` records a pseudonym of each actor, the SHA-256 of its organization and actor ids, unless
  `actor: 'id'` asks for the id.
- The webhook verifiers throw a `TypeError` for a missing or empty secret, before they read any header.
- `withTenantTransaction` refuses an empty or `null` isolation level and an organization id that is not a
  string, before it checks a connection out.
- `yaml` is no longer a dependency: `/openapi.yaml` and a skill's frontmatter are written by a small writer
  for JSON data.
- `ExecutionSink`, which nothing used, is removed from `@arbol-ai/maximus/analytics`.

Everything else:

- `bun create maximus my-api` (the new `create-maximus` package) asks whether the project serves MCP and
  has a React app, then runs `maximus init` of its own release. `maximus init` lays the starter out in
  layers (the API, its MCP server unless `--no-mcp`, a web app with `--web`) with tests that call the API in
  Node, and links the installed Maximus skill into `.agents/skills`, `.claude/skills` and `.codex/skills`.
  `maximus skills` links it in an existing project, and `maximus gen route` and `maximus gen tool` write a
  route or a tool file where `prepare` reads it. Every command says what it did in a sentence, or prints
  JSON with `--json`.
- A route is `defineHandler(handler, contract?)` in `routes/**/<name>.<method>.ts`: the handler receives
  `{ input, principal, env, fail, …context }` and answers its output or `fail(code)`, typed by the
  contract. Binding derives what a contract leaves out: the operation's name, from what the method does to
  what the path names (`listNotes`, `getNote`, `createNote`, `archiveNote`, `listDaySlots`), which
  `maximus prepare` writes into `.maximus/app.ts`; its title, as a sentence (`Get a note`); its group, the
  OpenAPI tag (`Notes`); its effect; its scope `<service>:<resource>:read|write`; and its tool's idempotent
  hint. Two routes that derive one name are refused with both named. `defineTool` declares a tool only MCP
  serves, in `mcp/tools/`.
- A new project maps `#src/*` to `./src/*` in its `package.json`, so a module of `src/` has one name from
  any folder: `import { NoteSchema } from '#src/notes.ts'`. The [Write code people and agents read
  easily](docs/guides/writing-code.md) guide sets the house style the examples, `maximus gen` and the
  Maximus skill follow. A project registers its base and error catalog in the global
  `MaximusRegister`, which types every handler's context and failures.
- `context.ts` (`defineContext`) prepares what every handler receives, `errors.ts` declares the error
  catalog and `auth.ts` (`defineAuth`) verifies tokens the application issues; `defineAuth` refuses the
  issuer, the audience and every other field `vite.config.ts` states. `telemetry.ts` (`defineTelemetry`)
  states whether diagnostics run, their observers, such as `analytics()`, and the active trace id.
  `PreparedContext` types operation middleware.
- `.maximus/env.d.ts` types `Env` from the declared bindings with Cloudflare's own inference, and types a
  binding to one of the Worker's own Durable Object classes as `DurableObjectNamespace` of that class.
- Each cron module's literal schedule becomes its trigger, and each queue module subscribes the Worker to
  the queue it names unless the options declare that consumer themselves.
- A file of `pages/` named for a method answers that method, as a route's does:
  `pages/webhooks/payments.post.ts` answers `POST /webhooks/payments`, so a project receives a provider's
  webhooks without a Worker composed by hand. A page answers any method that no file of its path declares
  with `405` and an `allow` header listing those that do. `createProjectWorker`'s `pages` takes a handler
  or a record of one per method.
- The MCP server is described in Markdown: `mcp/instructions.md`, `mcp/guides/<name>.md` as resources and
  prompts and `mcp/skills/<name>.md` as Agent Skills. The refusals the server answers itself (a hidden or
  unknown tool, a call over its operation's limit) are observed as admissions.
- With `index.html` at its root, a project is a web app: the same Worker serves the API under `/api` and a
  React app whose pages are the files of `app/routes/`, with a Content Security Policy that admits the token
  issuer, HSTS and same-origin policies, which `webApp.headers` adjusts. A Vite `base` or `build.assetsDir`
  that would move the build is refused.
- A route with a byte body reads it with `body.read()`, whose failure is the answer itself
  (`REQUEST_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE` or `INVALID_INPUT`, typed as `BodyFailure`).
- The Worker is minified, and `mcp()` loads the MCP SDK on the first MCP request, in a chunk of its own: a
  Worker with one route and no MCP builds to about 170 kB (50 kB gzip).
- `maximus prepare` writes `.maximus/http.ts`, the API as the Worker serves it, for tests in Node, and under
  Vitest `maximus()` resolves `cloudflare:workers` to a stand-in whose entrypoint and Durable Object classes
  keep the context and bindings a test gives them.
- A `workers.dev` origin is served there; any other origin becomes the Worker's custom domain unless
  `domains` or a fetch trigger route it.
- A telemetry switch that throws turns telemetry off for the call instead of failing it, and an unexpected
  error on the MCP endpoint is reported under the `mcp` surface.
- The router decodes every path segment before it matches one, so an encoded fixed segment reaches its own
  route. A transport refuses an operation whose scope the caller lacks with `FORBIDDEN`, also when the token
  names no client. `createWorker` runs every handler besides `fetch` (queue, email, scheduled, tail) inside
  the application's diagnostics. The MCP listing of a union input includes a record member's key patterns.
- Static assets, a web app's build or `createWorker`'s `assets`, answer an immutable asset only for a plain
  path: an encoded slash, an encoded character or a dot segment there is a 404.
- The OpenAPI document is written for SDK generators. Every request body, answer and failure is a named
  component (`CreateNoteBody`, `NoteResponse`, `NoteNotFoundFailure` and its answer `NoteNotFoundError`,
  `ListNotesBadRequestError` with a discriminator on `code` where several codes share a status), each
  operation has one tag, its group, which `groups` in `maximus()` describes as `description` describes the
  service, every parameter is described, and `x-failure-codes` names each status's codes. A route lists only
  the failures it can meet: routing's own `NOT_FOUND` and `HTTP_METHOD_NOT_ALLOWED` never, and a body's
  `REQUEST_TOO_LARGE` and `UNSUPPORTED_MEDIA_TYPE` only when it sends one. A DELETE whose path carries its
  whole input documents no body, and a body keeps its `minProperties` net of the path's fields. TypeScript
  types from openapi-typescript, and Go and Python clients from the OpenAPI Generator, compile from it.
- `maximus openapi` writes the document the Worker serves to `openapi.json`, and, when a route or tool
  declares `rpc`, the RPC document to `openapi.rpc.json`; `--check` fails when either is out of date. The
  format preset leaves every `openapi*.json` as written.
- `services` in `maximus()` binds other Maximus services' native RPC methods, each by its Worker's name and
  the RPC document it publishes, with props that name this service as the caller, and `maximus prepare`
  types each binding from its document in `.maximus/services/<binding>.ts`: one method per RPC operation,
  its input, its output and the union of its failures, which `code` narrows. A caller imports nothing of
  the other project, and its type check fails when that project's document changes in a way its calls do
  not follow. `createRpcOpenApi(app)` builds the RPC document: every operation served over native RPC,
  internal ones and tools included, as `POST /rpc/<method>` whose body is its whole input, with
  `x-rpc-callers`.
- The OpenAPI document gives a list query parameter `style: form` and `explode: false`, so a generated
  client sends `tags=a,b`, the one form the API reads, rather than repeating the key, which it refuses.
- Every refusal of `.build()` that concerns one operation names it, and a refusal of a route template names
  the path or the routes it concerns.
- `.build()` refuses a record whose keys follow a pattern unless it sets `additionalProperties: false`,
  without which a key outside the pattern passes with any value, and guide or skill names that collide with
  each other or with the OpenAPI document's resources. `maximus prepare` and `maximus gen route` refuse a
  route parameter the Worker would refuse, such as `[constructor]`.
- An operation's JSON body in another media type is refused with `415` before any of it is read.
- The OpenAPI document and the MCP tool listing publish an input field with a default as optional, since
  decoding fills it in, whether or not `inputSchema()` wraps the input; a `DELETE`'s body is required only
  when its input requires a field. The API's index names the MCP endpoint whenever the Worker serves MCP.
- `worker.service()` and `worker.durableObject()` keep a class's methods writable, so a class that binds a
  method to itself in its constructor constructs.
- Project discovery sees the MCP tool of a route declared as a `const`, refuses a route whose fields it
  cannot read, reads cron schedules before it replaces any output, and keeps an email recipient whose domain
  ends like a mode or test suffix.
- `maximus prepare` refuses, before any Worker starts, what used to fail later or never work: a page at a
  path the Worker answers otherwise, by the same rule the Worker applies; two routes of one method whose
  paths differ only in a parameter's name, naming both files; an import of a generated module from a page,
  a queue, an email or a Durable Object module, as from any other; a middleware, cron or queue module whose
  name keeps a dot besides `.dev` or `.prod`; and an email module named after neither a recipient nor
  `_default`, which no message would reach. It reads the configuration file Vite reads, in Vite's order.
  Its refusals name a project's files relative to the project. A route or middleware module that imports
  the generated API, `#maximus/http`, at runtime is refused as one that imports the application is, and so
  is a middleware module that imports `#maximus/middleware`, an import spelled `#maximus//http` or
  `#maximus/./app`, and `import { type x }` from a generated module, which `verbatimModuleSyntax` keeps.
- `maximus gen tool` and `maximus skills` refuse to write through a symlinked folder of the project.
- `observability` options merge key by key over the defaults, so a partial setting keeps query strings
  redacted, and logs and traces follow `enabled` unless set. Two cron modules on one schedule make one
  trigger, and `vp dev` restarts when a queue or cron module is added or removed.
- `auth0()` and `cloudflareAccess()` from `@arbol-ai/maximus/vite` state the `tokens` option for an API
  whose tokens Auth0 issues and for an application behind Cloudflare Access. `tokens.issuer` takes a list
  of the issuers one authorization server answers to, the canonical one first, such as an Auth0 tenant's
  domain and its custom domain.
- `tokens.source: 'cloudflare-access'` admits the application token Cloudflare Access sets in
  `cf-access-jwt-assertion`, and no other, verified against the team's keys for the application's AUD tag;
  `tokens.access` grants people and each service token their scopes, in one organization or in the one a
  claim names. Behind Access, OpenAPI describes the service token's headers, no OAuth discovery is served,
  no token reaches `authority.token`, a write another site's page sends answers `403`, MCP is refused, and
  a production build answers the origin alone. `projectAccessToken` maps an Access token's claims.
- A token of the client credentials grant, `gty: client-credentials` as Auth0 marks it, whose subject is
  not its client's machine, and a token whose `typ` header names another type than `JWT` or RFC 9068's
  `at+jwt`, are refused.
- Seven examples deploy to Cloudflare as they are, each with tests in Node and an end-to-end suite: tasks
  with a web app, notes in D1, two Workers over RPC, a queue with a dead letter queue, Browser Run, documents
  in R2 and a Durable Object that books appointments.
- CI runs, through Bun, the build, types, lint and format, the tests with coverage, the Postgres suite, the
  packed packages, the examples' OpenAPI documents through Redocly's strictest rules and
  openapi-typescript, and every example's end-to-end suite on each pull request and push to `main`;
  publishing follows a green CI on `main`, with provenance, and releases the version on GitHub with its
  section of this file.
- Dependencies: Vite+ 1.4, Vitest 5, TypeScript 7, Cloudflare's Vite plugin 2.0 beta, `cf` 1.0 beta,
  the MCP server SDK 2.4 and Bun 1.4.4.

## 7.4.0 (2026-10-26)

- Add root `maximus.config.ts`, named HTTP method declarations and generated typed Worker/application
  entries. Project starters no longer require `src/`; existing service and route factory layouts work.
- Reconcile route exports and optional modules on every Vite+ build and source change without executing
  application code on the build host. Oxc parses explicit exports and rejects ambiguous route modules.
- Discover ordered request middleware and post-admission operation middleware with explicit phases,
  preserving native HTTP security handling and the shared HTTP/MCP/RPC authorization pipeline.

## 7.3.1 (2026-10-26)

- Preserve project-name substitution in starter README titles when formatting templates with Vite+.

## 7.3.0 (2026-10-26)

- Add an optional project layout with typed file discovery, a public Hello World page and a protected
  greeting operation. The service layout stays compatible.
- Add `maximus prepare`, the optional `/vite` plugin and `/project` Worker composition for pages,
  ordered operation middleware, cron handlers, queue consumers, email recipients and Durable Objects.
- Generate English agent guidance and a GitHub workflow that deploys main after non-test validation.
  Framework CI keeps test suites and package smoke checks behind explicit manual authorization.
- Make Vite+ the workspace and starter toolchain: root checks and task orchestration, library packing,
  Worker builds and explicit test commands. Existing runtime exports remain compatible.

## 7.1.0 (2026-10-18)

- `@arbol-ai/maximus/projection` is back, for a gateway that builds MCP tools, CLI commands and
  clients from services' OpenAPI documents: `mcpToolName`, `kebab`, `snake`, `permissionDescription`
  and `queryKind`, with the types `QueryKind` and `SchemaResolver`, as in 6.2.1. `mcpToolName` takes
  a `ProjectedName` (`resource` and `verb`) where it took the retired `ApiName`. The entry is
  runtime-free, and the release check loads it from the packed package.

## 7.0.0 (2026-10-18)

Breaking:

- Maximus is published on npm as `@arbol-ai/maximus`, from this public repository. Up to 6.2.1 it
  was `@getarbol/maximus` on GitHub Packages: rename it in your dependencies and imports, and remove
  the `@getarbol:registry` line from `.npmrc`. `maximus init` starters no longer write an `.npmrc`.
- The oxlint preset no longer refuses imports of the `@getarbol/maximus-*` packages retired in 4.0.
- The platform Gateway layer is removed, so an application describes only itself. Gone: the
  application's `publication`, `service` (public name, permissions and roles), `connection`,
  `apiContracts`, `skills` and `openApiProjection`; each operation's `publish` and `api` name, and the
  scope, route and tool it derived; `/.well-known/integration`; the connections protocol
  (`CredentialSubmissionSchema`, `ConnectionStatusSchema`, `ConnectionService`); the
  `@getarbol/maximus/projection` entry; `apiContractProblems`, `operationPublished`, `originServes`
  and the types `ApiName`, `ApiContracts`, `ServiceDefinition`, `Publication`, `PublishedSurface` and
  `OpenApiProjection`. Every operation declares its `scope` and its `http`, `mcp` and `rpc` exposure.
  `createOpenApi(app)` takes no options and builds the one document the origin serves, whose root holds
  only OpenAPI's own fields: `x-maximus-service`, `x-maximus-tokens`, `x-maximus-skills` and the
  operations' `x-maximus-*` extensions are gone, while `x-required-scopes`, `x-effect`, `x-mcp-tool`
  and the other operation extensions stay. MCP skills stay in `mcp.skills`. `InvocationAuthority`'s
  `surface` is `http` or `mcp`; no transport ever set the third value, `bff`.
- `.operation()` refuses a definition field no operation has, such as a retired `api` name or a
  misspelled `http`: inline definitions do not compile, and `.build()` throws. Such a field used to be
  ignored, leaving the operation unreachable without a word.
- Maximus works with Cloudflare's [`cf`](https://developers.cloudflare.com/cf/) CLI (beta) instead of
  Wrangler, and no longer wraps it. The `maximus` CLI keeps one command, `init`: `check`, `deploy`,
  `dev` and `types` are removed, so run `cf build`, `cf deploy`, `cf dev` and `cf workers types`, and
  `cf workers check` for the startup profile. `createWorker` no longer marks its handler for the CLI.
  A Wrangler project converts with `cf migrate`.
- The lint and format presets ignore `.cloudflare`, where `cf` writes its Build Output and generated
  types, instead of `.wrangler-bundle` and `worker-configuration.d.ts`.
- The `@getarbol/maximus/captcha` entry is removed: `createCaptchaSolver`, the 2Captcha provider,
  `captchaErrorDefinitions` (`CAPTCHA_UNAVAILABLE`, `CAPTCHA_PAUSED`), the
  `maximus.captcha.failure` and `maximus.captcha.recovery_paused` log events and the types
  `CaptchaChallenge`, `CaptchaSolution`, `CaptchaAttemptFailure`, `CaptchaProvider` and
  `CaptchaStore`. A service that solves challenges keeps that code itself.
- The oxlint preset no longer refuses `@sentry/*` imports, nor imports of `@getarbol/sdk/*`, a
  private package.
- `defineErrors` refuses a failure named after a catalog member (`schema`, `definitions`, `status`,
  `retryAfter`, `validate`), in the type and at run time, as it refuses the standard names: such a
  failure's factory was silently replaced by the member.
- OAuth access tokens are read as the standard claims, so tokens from any provider work. A token
  that names no client (`azp` or `client_id`) is admitted without one, so its calls have no
  `authority`, where it used to be refused; a token without `scope` grants no scopes instead of
  being refused; a `permissions` claim may also be a space-separated string. A custom resolver's
  machine client may be named by its client id as well as `<client id>@clients`. As before, a
  person holds only the scopes their `permissions` claim also lists, and a machine's subject is
  `<client id>@clients`.

Other:

- Organization ids may be any id an identity provider issues: 1 to 128 letters, digits, `_` and `-`,
  starting with a letter or digit (`org_…` from Auth0, Clerk or WorkOS, UUIDs, slugs). Only Auth0's
  form, `org_` and 16 letters or digits, was accepted.
- `tokens.claims` reads tokens whose provider names the organization, the scopes, the client or a
  person's permissions differently, as a claim name or a dotted path (`{ scopes: 'scp', client:
  'cid' }` for Okta). `permissions: false` trusts the scopes alone, for an authorization server that
  grants each person only what they may hold, and `machineSubject: '{client}'` takes a subject equal
  to the client id for a machine, as RFC 9068 recommends. `tokens.algorithms` accepts any asymmetric
  JWS algorithm (`ES256`, `PS256`, `EdDSA`, …) where only `RS256` was.
- `tokens.authorizationEndpoint` and `tokens.tokenEndpoint` name the endpoints OpenAPI publishes as
  the OAuth flows' URLs, so a service whose authorization server is not Auth0 documents its own;
  they default to Auth0's `authorize` and `oauth/token`, as before.
- `tokens.development` accepts a development token from `localhost`, `127.0.0.1` or `[::1]` as a
  developer holding every declared scope, so `cf dev` runs without an authorization server and
  without the hand-written resolver every service copied. It never matches another host or a token
  shorter than 32 characters.
- `maximus init` writes a random development token to `.dev.vars`, readable only by its owner and
  ignored by Git, and the starter accepts it, so a new service runs with `bun run dev` at once.
- `maximus init` starters are `cf` projects: `cloudflare.config.ts` and `vite.config.ts` with
  Cloudflare's Vite plugin, `cf dev`, `cf build` and `cf deploy` as their scripts, binding and runtime
  types from `cf workers types`, and tests in workerd through `@cloudflare/vitest-plugin`, which reads
  `cloudflare.config.ts`. Wrangler is no longer a dependency. The development token is declared for
  `cf dev` alone, so no deployed build carries it, and `bun run deploy` deploys the build `verify`
  made. The release check now runs a new starter's own `verify` on the packed package, confirms its
  build carries no development token, and refuses a `file:` or `link:` dependency in the release as
  it refused `workspace:`.
- The examples are `cf` projects, and the two Workers of `worker-rpc` are packages of their own, since
  `cf` reads each Worker's own `package.json`; under `cf dev`, orders runs pricing beside it.
- Maximus is released under the MIT License, and the package ships its LICENSE.
- The package is built with tsdown: each entry is one ESM file with its declarations, and shared
  code lives once in a few chunks. The tarball holds 81 files instead of 253 and weighs about half
  (124 KB instead of 239 KB). Export paths, the `maximus` binary and every exported name are
  unchanged; source maps are no longer shipped.
- `maximus init` starters depend on cf ^1.0.0-beta.18, @cloudflare/vite-plugin ^2.0.0-beta.v.1, vite
  ^8.3.4, oxfmt ^0.73.0, oxlint ^1.88.0, ultracite ^8.0.1, vitest ^5.0.5 and @cloudflare/vitest-plugin
  ^1.4.4, run Bun 1.4.3 and Node 24 with actions/checkout v7 in CI, and use the compatibility date
  2026-10-12.
- Every public declaration, and every member of the package's types, carries a doc comment, so
  editors explain it on hover.
- MCP declares `listChanged: false` for tools, resources and prompts: the stateless server never sends
  list-change notifications, yet the SDK declared them, so a `subscriptions/listen` stream (revision
  2026-07-28) stayed open waiting for one. Such a stream is now acknowledged and closed at once.
- An MCP tool call may be as large as its operation's `maxBodyBytes` allows; the SDK refused every
  request body above 4 MiB.
- Every request after the first in an MCP JSON-RPC batch (2025-03-26 clients), a resource read as
  much as a tool call, passes the rate limit like a request of its own. A refused tool call answers
  the `RATE_LIMITED` tool error, and any other refused request the JSON-RPC error `-32000` with the
  failure as its `data`. A batch of up to 100 requests was counted once, so one request could make
  the server serialize its OpenAPI document a hundred times.
- The OpenAPI document's JSON and YAML texts are serialized once per isolate, not on every request
  to `/openapi.json`, `/openapi.yaml` or their MCP resources.
- A timestamped or Standard Webhooks signature header that lists more than eight signatures
  (`MAX_SIGNATURES`) is refused as `malformed` before any is computed: each cost an HMAC of the whole
  body, so one unsigned delivery with hundreds could take a second of CPU.
- Input validation builds only the ten issues an `INVALID_INPUT` failure carries; an invalid 1 MiB
  body with an issue per array item cost about 156 MiB of heap.
- The MCP endpoint admits the largest body among the tools the caller may call, not among every tool:
  a caller who cannot call a large import is refused a large body with `413` before it is parsed.
  `HttpTransport.maxBodyBytes` receives only the operations the caller's scopes and actor kind admit.
- A `tools/list` cursor the server did not issue, an empty one included, answers JSON-RPC invalid
  params (`-32602`) instead of an internal error.
- An unexpected failure in the MCP server's own handlers answers the JSON-RPC internal error with
  the message `Internal error` and is reported as `maximus.unexpected`; it used to answer with the
  failure's own message and went unreported. A client's mistake that the SDK refuses with a 4xx, such
  as an unsupported protocol revision, is no longer reported as `maximus.unexpected`.
- The typed client sends a GET input's numbers, booleans and string lists in the query string the
  way the service reads them back (`?limit=10&active=true&tags=a,b`). Its types already allowed
  them, but it threw `Query values must be strings.`; a value no query string can carry, such as
  `NaN`, an empty list or a list item with a comma, is still refused before anything is sent.
- Under `http.basePath`, the MCP OpenAPI resources are named by the URLs that serve the document
  (`<origin><basePath>/openapi.json`) instead of URLs without the base path, which answered 404.
  `TransportContext` gains `url(path)`, the public URL of one of the application's own paths.
- An MCP tool whose input is a union lists it as one object, with every member's fields and the
  discriminator as an `enum`, instead of a root `anyOf`. Hosts that refuse a root `anyOf`, the
  Anthropic API among them, failed every tool of the request; calls are still checked against the
  exact union.
- The MCP server info carries the application's `title`, the two OpenAPI resources have their own
  titles and a description, and each tool definition is built once instead of on every listing.
- Every type a public signature uses can be imported from the entry that exports the signature. New
  type exports, runtime exports unchanged: from the root `ApplicationConfiguration`, `Exposure`,
  `OperationMiddleware`, `Success`, `FailureResult`, `ErrorDefinition`, `ErrorCatalog`,
  `ErrorFactory`, `DefinedErrors`, `HttpOptions`, `BodyReadOptions`, `HttpBodyFailure`,
  `HttpBodyFailureReason`, `OpenApiProjection` and `BackgroundContext`; `Checked` and `InputIssue`
  from `/schemas`; `ErrorFactory` and `DefinedErrors` from `/errors`; the body types from `/body`;
  `ErrorDescription` from `/diagnostics`; `ApiName` from `/projection`; `WorkerOptions` from
  `/workers`; `ClientManifest` and `ResponseMode` from `/client`.
- A catalog's `validate()` and `schema` are typed as the catalog's own failures instead of `any`.
- `.mount()` of a module that declares an operation the builder already has is refused by the type,
  not only by the `TypeError` at run time.
- Handler and reader types follow decoding: a standalone `operation()` handler receives
  `StaticDecode` of its input as the builder's does, and `inputSchema()`, `checkSchema` and
  `readSchema` answer decoded TypeBox transforms. The typed client and RPC methods send a field
  declared with `transformSchema`, `normalizeSchema` or `pipeSchema` as its source, which is what
  the server checks and OpenAPI documents.
- The declarations compile without the DOM library (Workers and Node type libraries, `skipLibCheck`
  off): `ClientOptions.credentials` and `cache` spell out their Fetch modes, and `RouteContext.fail`
  takes `ResponseInit['headers']`. Getting started now states the TypeScript the declarations need:
  5.7 or later, as before.
- Internally, the construction rules, the HTTP handler, the OpenAPI projection and the CLI's
  Worker reading are split into named steps; requests, responses, documents and messages are
  unchanged.

## 6.2.1 (2026-10-17)

- `openApiProjection: 'platform'` on the application makes `/openapi.json` (and its YAML forms)
  document only what the service publishes on REST, instead of every route it declares
  (`'origin'`, still the default). The platform Gateway merges the same published operations from
  either, so a service can keep the routes it serves its own dashboard out of its public document
  without changing the platform's. Every route is still served.

## 6.2.0 (2026-10-17)

Names the schemas every service publishes alike, so the platform's OpenAPI document, and every SDK
generated from it, has one type for each; and checks that the standard verbs look the same
everywhere. No response, request or validation changes.

- Every success and failure response refers to one `ResponseMetadata` component,
  `{ requestId: string }`. `FailureResponse.error` adds `allOf: [Failure]`: each code's variant
  narrows the new `Failure` base, `{ code, message, retryable, data }` (exported as `FailureSchema`),
  and `INVALID_INPUT`'s issue item is `ValidationIssue`, `{ path, message }`.
- Existing exports gain an `$id`, nothing else: `OrganizationIdSchema` (`OrganizationId`),
  `UuidSchema` (`Uuid`), `CredentialSubmissionSchema` (`CredentialSubmission`) and
  `ConnectionStatusSchema` (`ConnectionStatus`).
- Added named schemas for later adoption: `EmailAddressSchema` (format email, at most 254),
  `PhoneNumberSchema` (E.164), `HttpsUrlSchema` (`^https://`, at most 2048), `HexColorSchema`
  (`#rrggbb`), `DeletedObjectSchema` (`{ id, deleted: true }`), `SignedUrlSchema`
  (`{ url: HttpsUrl, expiresAt: date-time }`), `NamedReferenceSchema` (`{ id, name }`) and
  `PostalAddressSchema` (FHIR-shaped `{ line, city, state, postalCode, countryCode, use }`).
- Added one list contract: `PageQueryFields` (`cursor`, `direction` `forward` | `backward`, `limit`
  1–100 with default 25), `pageLimit({ maximum, default })` for another limit, `PageInfoSchema`
  (`PageInfo`: `hasNextPage`, `hasPreviousPage`, `nextCursor`, `previousCursor`) and
  `Page(item, { $id })`, which names a list's `{ object: 'list', data, pageInfo }`; with the types
  `Page<Item>`, `PageInfo`, `PageQuery` and `TPage`. See [Lists](docs/guides/schemas-and-validation.md#lists).
- Added the verbs' contracts: a `list`, and any operation returning a collection, answers a `Page`
  of a named item and takes the pagination fields; `get`, `create` and `update` answer the list's
  named item; `delete` answers `DeletedObject`. `apiContractProblems(operations)` lists the
  operations that break them, and `maximus check` prints them as `warnings`, which fail neither the
  check nor a deploy. `apiContracts: 'strict'` makes `.build()` refuse them. **7.0.0 will make
  `strict` the default.**
- MCP tool schemas are self-contained: no `$id`, each named schema written where it is used and a
  recursive one once under `$defs`. MCP clients that validate with Ajv (the MCP TypeScript SDK)
  refused a tool schema that repeated an `$id`, such as two `Uuid` fields or a recursive schema used
  twice. `x-maximus-input-schema` and `/.well-known/integration` write named schemas in place too, so
  what the platform reads from them is unchanged.

## 6.1.0 (2026-10-15)

- Added the application's `skills`: Agent Skills published at the root of the OpenAPI document as
  `x-maximus-skills`, for a platform that registers a service from its document and
  offers them with its operations. Same rules as `mcp.skills`, which still serves skills over MCP only.

## 6.0.0 (2026-10-14)

Breaking:

- The `@getarbol/maximus/composio` entry and the `maximus-composio` command are removed
  (`registerConnection`, `publishCatalog`, `CatalogPublication`). The Composio integration is
  retired.

## 5.0.0 (2026-10-14)

The platform Gateway is now a plain proxy: it forwards `/v1/<service>/<path>` to each service's own
origin with the caller's token and merges the services' `/openapi.json`, and services call each other
over native RPC. 5.0 removes the pieces of the earlier designs that nothing calls anymore.

Breaking:

- Signed admission and unsigned delegated grants are removed: the `@getarbol/maximus/delegation` and
  `@getarbol/maximus/admitted` entries (admission proofs and keys, `callAdmitted`, the admission
  service's schemas, `operationContract`, `authorizeDelegatedOperation`, `DelegatedGrant`), the
  application's `admission` and `delegation` policies, the operation fields `admission`, `delegated`,
  `resourceSlots` and `execution`, and `InvocationAuthority.admission`. `isResult` moves to the root,
  `@getarbol/maximus`. `authority.token` stays.
- The Gateway's token mode is removed: `worker.delegatedEntrypoint`, the application's `gateway`
  policy, `gatewayServes` and the types `GatewayPolicy` and `GatewayCall`. A service accepts the
  platform's tokens by listing the platform audience in `tokens.audience`.
- The service artifact and its publishing are removed: `exportServiceContract`, `ContractBuild`, the
  application's `contract` setting, the `maximus publish`, `maximus export` and `maximus permissions`
  commands with their `--out`, `--entrypoint`, `--allow-dirty`, `--package`, `--registry`, `--notify`
  and `--notify-workflow` flags, and `createOpenApi`'s `artifact` projection.
- `service` keeps only `publicName`, `permissions` and `roles`: `kind`, `owner`, `dependencies` and
  `connections` are removed, and `x-maximus-service` no longer carries `kind`.
- `originRoutes` is removed. A selected service's origin serves and documents every declared route
  and MCP tool, as `originRoutes: 'declared'` did, since the Gateway forwards every call there; a
  private one still serves none. `originServes(publication, operation, surface)` loses its
  `originRoutes` argument, and the type `OriginRoutes` is removed.
- The OpenAPI document no longer carries `x-maximus-gateway` or `x-maximus-failures`. It carries
  `x-maximus-tokens: { issuer, audiences }` instead, the authorization server and audiences whose
  tokens the service verifies (`null` when it issues its own bearer tokens): a Gateway that required
  `x-maximus-gateway.audience` now checks that `x-maximus-tokens.audiences` includes its audience.
  Every other extension the Gateway reads is unchanged.
- `@getarbol/maximus/projection` keeps `mcpToolName`, `kebab`, `snake`, `permissionDescription` and
  `queryKind`; `publicName`, `cliCommand`, `restRoute`, `encodeQuery`, `decodeQuery` and the types
  `RestRoute` and `RestMethod` are removed.
- `maximus check` no longer requires `worker.delegatedEntrypoint` or `{ caller, mode: 'admitted' }`
  bindings, and asks for a service definition only when the application publishes operations.
- The `admitted-owner` example and the signed admission and Gateway token mode guides are removed.

Other:

- Schema bundling lives in `createOpenApi` alone, so every document an origin serves keeps only local
  `$ref`s, as since 4.0.0. A test now covers a recursive `$id` schema that a service spreads to
  describe one use (`{ ...value, description }`, `{ ...t.Optional(value), description }`) or nests in
  another named schema, the shape services on 4.0.0-next releases saw left as a bare `$id`.
- The native RPC entrypoint keeps a workerd test of its caller props and principal checks, which the
  removed delegated-entrypoint test used to cover.

## 4.0.0 (2026-10-14)

The first stable 4.0 release, published under `latest`; it is 4.0.0-next.11 without the prerelease
tag.

Breaking:

- Maximus is one package, `@getarbol/maximus`. The former packages are its entries:
  `@getarbol/maximus/workers`, `/mcp`, `/client`, `/analytics`, `/captcha`, `/composio`, `/postgres`
  (one entry for transactions and their failures), `/testing` (`verifyContract`), `/oxlint` and
  `/oxfmt`. It installs the `maximus` and `maximus-composio` commands and ships the Agent Skill.
  `pg` and the lint toolchain are optional peer dependencies.
- `createWorker`'s `adapters` option and the `RuntimeAdapter` and `RuntimeApplication` types are
  removed (deprecated in 3.17.0).
- The `maximus token` command is removed, with its `--url`, `--issuer`, `--organization`, `--output`
  and `--scope` flags.
- The CLI needs no configuration of its own. It finds Workers the way Cloudflare's tools do (the
  directory it runs in when it holds a `cloudflare.config.ts` or a Wrangler file; at a workspace's
  root, every package that does) and reads the rest from each Worker's module, with
  `cloudflare:workers` inert: the application `createWorker` was given, the web app its `assets`
  serve, and the export that is `worker.delegatedEntrypoint`, recorded as the artifact's entrypoint.
  A command names one Worker by its directory (`maximus deploy api`); `check` and `permissions`
  without one cover them all. The `--wrangler` and `--worker` flags are gone: the Worker's own
  configuration names both. The application's new `contract` setting (`package`, `registry`,
  `notify`, `notifyWorkflow`, validated when it is built) tells `maximus publish` where the contract
  goes; the flags still override it. `maximus export` outside a Git checkout says so instead of a
  stack.
- A Worker can be a [`cf`](https://developers.cloudflare.com/cf/) project, Cloudflare's new CLI
  (beta), or keep its Wrangler file until it migrates. For a `cf` project, `maximus check` runs
  `cf build` and checks the resolved configuration in its Build Output (assets, bindings, the web
  app's files) and the startup `cf workers check` profiles; `maximus deploy` deploys the build it
  checked with `cf deploy --prebuilt`; `maximus dev` and `maximus types` run `cf dev` and
  `cf workers types`; `--mode` builds and deploys a mode. When a build holds several Workers,
  commands act on its default one, as `cf deploy` does. The CLI never loads `cloudflare.config.ts`
  (`cf` runs on Node only) and starts `cf` with the real Node even under `bun --bun`. `check` also
  reads the built module: every trigger needs its handler (`scheduled`, `queue`, `email`,
  `connect`) and every declared export must exist. While reading a module, `cloudflare:workers`
  provides every runtime name, inert, so a bundled Worker links.
- `maximus check` verifies the web app a Worker serves (the asset server leaves every response to
  the Worker: `htmlHandling`/`html_handling` `"none"`, `notFoundHandling` `"none"`,
  `runWorkerFirst` `true`; the assets are bound; the build holds `index.html`, the files and the
  immutable folders), and that a service publishing operations through the platform Gateway exports
  its entrypoint.
- `originRoutes: 'none'` for a selected service reached only through the platform Gateway: its
  origin serves no operation and no discovery document (`/`, `/openapi.json`, OAuth metadata), so a
  web app owns those paths, while `/v1/…` and `/.well-known/…` stay a native 404. It mounts no
  transport.
- The lint preset enforces Maximus's guardrails in Worker code: the `maximus` oxlint plugin refuses
  `fetch`'s `redirect: 'error'`, `process.env` is refused, and so are imports of `zod`, `hono`,
  `elysia`, the retired `@getarbol/maximus-*` packages, the old `@getarbol/sdk/*` primitives and
  `@sentry/*`. Tests, scripts, examples and tool configuration keep Node's options. The presets
  require Ultracite 8, oxlint 1.86 and oxfmt 0.71 or later. See
  [Lint and format](docs/guides/lint-and-format.md).

Added:

- `createWorker`'s `assets.development` (pass `import.meta.env.DEV`) serves a Worker and its web app
  built by one Vite build with the Cloudflare Vite plugin: in development, a `GET` the Worker does
  not serve as a page, file or immutable asset is forwarded to Vite's dev server behind the binding.
  `maximus check` refuses a build that still forwards.
- `tokens.audience` accepts a list: a token whose `aud` names any one of them is verified, so a
  service can accept both its own audience and the platform's on its origin. The first is the
  canonical resource OAuth discovery names. `.build()` refuses an empty audience, an empty list and a
  repeated audience.
- An origin `GET` reads each declared query field as its kind: `?limit=2&active=true&tags=a,b` is
  `{ limit: 2, active: true, tags: ['a', 'b'] }`, as generated clients write it. An integer or boolean
  field in a query no longer fails as `INVALID_INPUT`; a field whose wire schema is a string (an
  `inputSchema(schema, wire)` codec) stays a string.
- An operation called over HTTP or MCP on the service's origin receives the verified access token in
  `authority.token`, as on a Gateway call in token mode, so it can call another platform service as
  the same caller.
- The OpenAPI document carries what the platform Gateway read from the service artifact, with the
  artifact's values, in every projection: on each operation `x-maximus-api` (its `api` name),
  `x-max-body-bytes` and `x-max-output-bytes` (now always, with the limits in force) and, beside
  `x-mcp-tool`, `x-mcp-idempotent` and `x-mcp-open-world`; at the root `x-maximus-service` (kind,
  public name, permissions and role grants), `x-maximus-gateway` (the platform audience and issuer,
  or `null`) and `x-maximus-failures` (the artifact's `failureCatalog`). `x-maximus-service`
  `permissions` adds to the declared ones every scope and conditional scope of an operation published
  to the Gateway, internal ones included. Nothing else enters a projection: internal operations stay
  out of the public and origin documents. See the
  [wire formats reference](docs/reference/wire-formats.md#openapi).

Fixes:

- Every OpenAPI document bundles `$id`-named schemas (TypeBox `Recursive` and `Ref`) into components,
  as the service artifact does, so each `$ref` is a local `#/components/schemas/<name>` pointer: the
  document an origin serves at `/openapi.json` and `createOpenApi(app)` named a recursive schema by
  its bare `$id`, which no OpenAPI reader resolves.
- Each failure response of the OpenAPI document names every code that answers with its status, with
  its message, and narrows `FailureResponse` to those codes; when several codes shared a status, it
  described only the last one. The status keys and `FailureResponse` are unchanged.
- `maximus publish --dry-run` creates its `--out` folder; `npm pack` failed when it did not exist.
- `maximus deploy` runs the project's `verify` on the real Node: under `bun --bun`, a `cf` command in
  it ran on Bun's `node` and refused to load `cloudflare.config.ts`.
- CLI errors print as one sentence, without a stack trace (`MAXIMUS_DEBUG=1` shows it), and the
  built `maximus` and `maximus-composio` commands are executable inside the Maximus workspace too.

## 3.17.0 (2026-10-11)

- `@getarbol/maximus-sentry` is retired; 3.16.0 is its last version. Telemetry is Cloudflare's own
  Workers Logs and traces, and Maximus sends nothing to a third party (see the observability guide).
- `createWorker`'s `adapters` option and the `RuntimeAdapter` type are deprecated: no adapter remains.
  4.0 removes them.

## 3.16.0 (2026-10-11)

- An operation with an `api` name needs little else: `scope` is derived when omitted (reads accept
  `<namespace>:<resource>:read` or `:write`, writes and deletes need `:write`), and so are `http`
  when it is published on REST (the route its public name projects to on the service's own origin)
  and `mcp` when it is published on MCP (`<resource>_<verb>`). Declared values win; without `api`,
  `scope` stays required.
- `failures` on an operation lists the domain failure codes it may answer. Its OpenAPI then documents
  only those and the standard ones, and any other domain failure it returns becomes `INTERNAL_ERROR`
  and is reported. OpenAPI tags default to the `api` resource.
- Declaring MCP tools no longer requires the application's `mcp` configuration; serving MCP on the
  origin still does.
- Fix: a Gateway call's verified token (`InvocationAuthority.token`, 3.13.0) now reaches the
  operation; the executor rebuilt the authority without it.

## 3.15.0 (2026-10-11)

- The service artifact's OpenAPI also documents the internal operations published to the private
  projection, each marked `x-maximus-visibility: internal`, so a Gateway can route them
  (`createOpenApi(app, { projection: 'artifact' })`). The service's own `/openapi.json` is unchanged:
  internal operations stay out of it.

## 3.14.0 (2026-10-11)

- The service artifact names its Gateway policy, `gateway: { audience, issuer }` or `null`, so a
  Gateway binds an owner in token mode only when it verifies the platform's tokens itself.

## 3.13.0 (2026-10-11)

- `InvocationAuthority.token`: on a Gateway call in token mode, the caller's verified access token,
  for an owner that calls another platform service as the same caller (which verifies it again).
  Absent on every other surface. Never log, store or return it.

## 3.12.0 (2026-10-11)

- Gateway token mode. A `selected` service sets `gateway` (`GatewayPolicy`: the platform audience, the
  issuer, optional `jwksUri` and `authorize`), and its `delegatedEntrypoint`, bound with props
  `{ caller: 'gateway', mode: 'token' }`, receives `operationName({ token, surface, requestId }, input)`
  for the operations published on that surface. The owner verifies the caller's own token itself and
  holds it to the operation's actor kinds, scopes and its own rules (`authorizeGatewayOperation`,
  `GatewayCallSchema`, `GatewayPropsSchema` and `gatewayServes` from `@getarbol/maximus/delegation`;
  `gatewayServes` and the types also from the root). The Gateway asserts nothing for the caller.
- An internal operation (`visibility: 'internal'`) may be published: it enters the platform's private
  projection, routed for tokens that carry its scope and absent from public documents and clients.
  The service artifact names each operation's `visibility`.
- `@getarbol/maximus/webhooks`: HMAC, timestamped (`t=…,v1=…`) and Standard Webhooks signature
  verification on the raw body. `@getarbol/maximus/diagnostics` also exports `createRequestId`,
  `parseTraceParent` and `durableCorrelation`. These were the last primitives services still took from
  the retired `@getarbol/sdk` package.

## 3.11.0 (2026-10-11)

- `AuthorityDescriptionSchema` takes an optional `tools` array (`RuntimeToolSchema`, exported with the
  `RuntimeTool` type from `@getarbol/maximus/delegation`): describing an agent, the admission signer
  can say how its runtime offers each permitted operation to a model, from the pinned release (public
  name, tool name, words, effect, exact input, the owner's namespace and admitted method). A runtime
  then calls the owner with `callAdmitted` and needs no generated client for those operations.

## 3.10.0 (2026-10-11)

- `maximus publish` publishes the service artifact of the deployed commit as a versioned package
  (`1.<date>.<time>` of the commit, the exact bytes as `contract.json`, `latest` being what runs) and,
  with `--notify`, starts the platform's release workflow with that version. It refuses what
  `maximus deploy` refuses; a re-run publishes nothing twice; `--dry-run --out` packs it locally.
- Documentation and the Agent Skill: in a Worker, `fetch` with `redirect: 'error'` throws before any
  request; send credentials with `redirect: 'manual'` and refuse a `3xx`. Services that set the option
  failed every such call.

## 3.9.2 (2026-10-11)

- The CLI is run as `bun --bun maximus`, which resolves only the project's own dependencies. The
  documentation said `bunx --bun maximus`, and without `@getarbol/maximus-tooling` installed `bunx`
  downloads the unrelated public npm package named `maximus`. `maximus deploy` runs the project's own
  Wrangler (`bunx --no-install wrangler`) and never downloads one.

## 3.9.1 (2026-10-11)

- `maximus deploy` cross-checks only an application that declares a service definition; it refused
  every plain service, since `maximus check` requires a definition.

## 3.9.0 (2026-10-11)

- `maximus deploy` deploys one reviewed commit: it refuses any tracked, staged or untracked change
  and any commit the upstream branch does not hold, runs the project's `verify` and `maximus check`,
  then runs `wrangler deploy` with the commit as the Worker version's tag and message. `--dry-run`
  stops at Wrangler's dry run.

## 3.8.0 (2026-10-11)

- `service.permissions` declares permissions of the shared audience beyond the operations' scopes,
  such as a provisioning grant the service's own policy checks, and describes any of them. Roles may
  grant them, `'*'` includes them, and the contract artifact carries them.
- `maximus permissions` lists those permissions and describes each from its declaration or its
  scope (`permissionDescription`, in `@getarbol/maximus/projection`). It used the first operation's title, so a write scope that a read operation also accepts
  read "List …", and a permission no operation declares was missing from the plan.

## 3.7.0 (2026-10-11)

- A `DELETE` with no body and no `content-type` is the empty input; it used to answer 415, so a
  REST-style delete of a path-addressed resource needed a `{}` body.
- `.build()` requires `tokens.resourceMetadataUrl` when `tokens.resources` names any resource: the
  default discovery document is not served then, and a 401 challenge pointed clients at a 404.

## 3.6.0 (2026-10-11)

- `.build()` refuses an OAuth application without `tokens.issuer`, or with a relative or non-HTTPS
  issuer or `jwksUri`. Verification is built on first use, so before, such an application started
  and then answered 401 to every token and 500 for its OpenAPI document. An application whose scheme
  is `bearer` (its own tokens) names no issuer.
- `.build()` refuses an operation input that uses a codec (`normalizeSchema`, `transformSchema`,
  `inspectSchema`, `refineSchema`, `pipeSchema`, `stripObject`) outside `inputSchema()`: a plain
  decode skipped them without a word, admitting raw, unnormalized and unrefined input.
- `.build()` checks the application's `maxOutputBytes` like an operation's (a positive integer up to
  16 MiB).
- `maximus init` starters depend on the release that created them, set `tokens.issuer`, name the
  package, Worker, namespace and entrypoint after the project (`demo-notes` exports
  `DemoNotesService`), use `wrangler types` instead of `@cloudflare/workers-types`, and pass their
  own `bun run verify` as generated. Names are kebab-case, 2 to 41 characters. The package check now
  asserts the starter's dependencies and issuer.
- The `maximus` CLI prints its full usage for an unknown command and no longer parses the Sentry and
  Composio flags; `maximus-sentry` and `maximus-composio` name themselves in their usage errors.
- Documentation rewritten as getting started, concepts, task guides, reference and design pages;
  `docs/framework.md` now points to the new pages.
- Runnable examples: a minimal HTTP service, HTTP and MCP together, two Workers over native RPC, and
  an owner that accepts signed admitted calls. They typecheck with the workspace.
- The Maximus Agent Skill gains references loaded on demand, and `@getarbol/maximus-tooling` ships
  them with `SKILL.md`.

## 3.5.0 (2026-10-11)

- Added `@getarbol/maximus/admitted` (`callAdmitted`, `isResult`) and `@getarbol/maximus/failures`
  (`STANDARD_FAILURES`): entries without a runtime or schema library for dispatchers that only
  forward proofs and present failures. `defineErrors` builds the standard failures from the same
  table, and the existing entries re-export both.

## 3.4.1 (2026-10-11)

- Fixed `callAdmitted` through real Service Bindings. It invoked the method with
  `Function.prototype.call`, which on a workerd stub names a remote method `call`, so every admitted
  call through a binding failed and read as an unknown outcome. It now calls the method on the stub.

## 3.4.0 (2026-10-11)

- Admitted operations declare the input field that names the files they read
  (`admission.attachments: { field }`). References the edge does not admit, and edges that admit
  files to an operation that reads none, are refused. The declaration is part of the contract digest
  and the artifact.
- The admission service contract's `describe` accepts an internal runtime's agent and answers the
  installation that assigns it.

## 3.3.1 (2026-10-11)

- Fixed: a plain route may sit beneath a transport's path, such as a second MCP server at
  `/mcp/<name>`. A transport answers only its exact path.

## 3.3.0 (2026-10-11)

- `INVALID_INPUT` carries `data.issues` on every transport: at most ten `{ path, message }` pairs,
  with RFC 6901 paths and messages that never contain input values.
- `checkSchema` and `decodeInput` share one reading of a failed decode, so refinements and
  normalized text report at their own paths.

## 3.2.0 (2026-10-11)

- Added `checkSchema` and `readSchema` to `@getarbol/maximus/schemas`, for reading stored, provider
  and model data with the schema's owner semantics.

## 3.1.0 (2026-10-11)

- Added `@getarbol/maximus/projection`: public names, REST routes, MCP tool names, CLI commands and a
  typed query codec shared by servers, clients and CLIs.
- Added the admission service's native contract (`AdmissionService` and its schemas) and
  `callAdmitted`.
- Added the standard `OUTCOME_UNKNOWN` failure (502, never retryable).

## 3.0.0 (2026-10-11)

Breaking:

- Wire identifiers are neutral: admission proofs are typed `maximus-admission+jwt`, classification
  extensions are `x-maximus-*`, security schemes are `oauth2` and `bearer`, and a service
  definition's owner is `'platform'` or a customer.
- There is no default authorization server. `tokens.issuer` is required wherever OAuth tokens are
  verified or documented; the verifier is built on first use.
- `maximus token` requires `--issuer` and reads `MAXIMUS_CLIENT_ID` and `MAXIMUS_CLIENT_SECRET`.

Signers and verifiers of admission proofs must upgrade together.

## 2.18.1 (2026-10-11)

- The CLI resolves `cloudflare:workers` to inert classes while reading an application, so `check`,
  `export` and `permissions` load modules that define Durable Objects or Workflows.
- `maximus export` takes the Worker name from the Wrangler configuration unless `--worker` is given.

## 2.18.0 (2026-10-11)

- Added the application's `service` definition: kind, owner, public name, dependencies, connections
  and recommended roles, validated at construction and required by the artifact.
- Added `maximus check`, `maximus export` and `maximus permissions`.

## 2.17.0 (2026-10-11)

- Added `api: { resource, verb, id? }`, the platform name of a published or admitted operation:
  unique per service, validated against its verb, and part of the contract digest and artifact.

## 2.16.0 (2026-10-10)

- Service artifacts bundle recursive schemas into components, one per structural variant, so every
  reference is a local component pointer.

## 2.15.0 (2026-10-10)

- Added `originRoutes: 'declared'`, which keeps every declared route on a selected service's own
  origin while `publish` still decides the platform projection.

## 2.14.0 (2026-10-10)

- The service artifact carries `failureCatalog`: each failure code's status, retryability and
  `Retry-After`.
- Added `importAdmissionKeys` for pinned public Ed25519 keys.

## 2.13.0 (2026-10-10)

- Added classification: `publication: 'private' | 'selected'`, explicit `publish` choices,
  `actorKinds` and `scopeMatch: 'all'`.
- Added signed admission: Ed25519 proofs valid for at most 60 seconds, carrying the ingress, the root
  command's digest, exact resources and finite dependency edges, verified by owners per operation.
- Added `exportServiceContract`, `mcp({ path })` including a root mount, and `http.origins`.

## 2.12.0 (2026-10-07)

`@getarbol/maximus`, `-workers` and `-client`; the other packages stayed at 2.10.0.

- Added item routes (`/v1/notes/{noteId}`) compiled into a segment trie.
- Added binary uploads (`http.body: 'bytes'`) and attachment downloads (`AttachmentOutputSchema`).
- Added input codecs: `inputSchema`, defaults, normalizers, transforms, refinements and wire schemas
  for query strings.
- Added `tokens.resources` (RFC 9728 metadata), `http.healthPath`, `basePath`, prefix `mounts`,
  `before`, `aroundOperation` and `fallback`, and Workers static `assets`.
- The client infers uploads and attachments, adds a data response mode, `onFailure`, request hooks,
  cancellation and `maxResponseBytes`.

## 2.10.0 (2026-10-06)

- The MCP endpoint admits the largest body limit among its tools and holds each call to its own
  operation's limit.

## 2.9.0 (2026-10-06)

- Added `mcp.skills` (the MCP Skills extension) and `mcp.skillTool`.

## 2.8.0 (2026-10-05)

- The client accepts a base URL with a mount path.

## 2.7.0 (2026-10-04)

- Telemetry storage is created on first use, so browsers can import contract modules; the `/schemas`
  entry exports the runtime-free schema vocabulary.

## 2.6.0 (2026-10-04)

- Added `tokens.scheme: { type: 'bearer', description }` for application-issued tokens.

## 2.5.0 (2026-10-04)

- Inputs and outputs may be unions of strict objects; construction errors name the operation and the
  rule.

## 2.4.0 (2026-10-04)

- Added `visibility: 'internal'`.

## 2.3.0 (2026-10-04)

- An operation's scope may be a list, any one of which admits the caller.
- Added per-operation `maxBodyBytes` and plain routes by exact path.
- The client accepts plain HTTP on loopback origins.
- Added unsigned delegated authorization through a separate delegated entrypoint.
- Added `@getarbol/maximus-postgres` 0.1.0: short tenant-scoped transactions, independent of the
  core.

## 2.2.2 (2026-09-23)

The first release in this repository's history (some packages at 2.2.3), including Composio catalog
publication (`publishCatalog`).
