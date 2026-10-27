/**
 * What an application is: its operations, their exposure on each transport and the configuration
 * every transport reads. `define-app.ts` holds the rules `.build()` checks against these shapes.
 */
import type { Static, TSchema } from '@sinclair/typebox';

import type { BinaryBody } from './binary.ts';
import type { Failure, ErrorCatalog } from './errors.ts';
import type { Result } from './result.ts';
import type { StaticDecode } from './schema-types.ts';
import { matchesScopes } from './scopes.ts';
import type { ScopeMatch } from './scopes.ts';
import { STANDARD_FAILURES } from './standard-failures.ts';
import type { TelemetryConfig, BackgroundContext } from './telemetry.ts';
import type { Principal, TokenPolicy, TokenClient } from './tokens.ts';

/**
 * What the transport verified about a call's token, kept apart from the principal: the surface, the granted
 * scopes, the OAuth client and the token itself. Context preparation and handlers receive a frozen copy.
 */
export interface InvocationAuthority {
  /** The transport whose admission verified the token: `http` or `mcp`. */
  readonly surface: 'http' | 'mcp';
  /** The scopes the verified token grants, which a handler checks its `conditionalScopes` against. */
  readonly scopes: readonly string[];
  /** The OAuth client the verified token was issued to: its id and its class, `human`, `machine` or `dcr`. */
  readonly client: Readonly<TokenClient>;
  /**
   * The bearer token the call was admitted with, verified: on an HTTP or MCP call to the service's origin,
   * including one a gateway forwards. It is the caller's OAuth access token, unless
   * `tokens.resolve` admitted another credential (a workload key under `oauth+bearer`) or it is the
   * development token; absent under the application's own `bearer` scheme. An operation passes it on to call
   * another service as the same caller, and that service verifies it again. Never log, store or return it.
   */
  readonly token?: string;
}

/**
 * What preparation and middleware start from for one call: the env, the verified principal and authority, the
 * decoded input, the operation's name, a declared byte body and the runtime's background work.
 */
export interface Invocation<Env> {
  /** The Worker's bindings; inside `http.aroundOperation`, the environment that hook passed to `run`. */
  env: Env;
  /** The request body's reader, present only on an HTTP operation that declares `http.body: 'bytes'`. */
  readonly body?: BinaryBody;
  /**
   * The verified caller: its actor, actor kind, organization and request id. Scope every tenant query by its
   * `organizationId`.
   */
  principal: Principal;
  /**
   * The verified token's surface, scopes, client and token, on HTTP and MCP calls whose token names a client;
   * absent over RPC and for a token that names no client.
   */
  readonly authority?: InvocationAuthority;
  /** The operation's input, decoded and checked once; preparation must neither check it again nor log it. */
  readonly input?: unknown;
  /** The name of the operation being called, which the builder sets; never taken from caller input. */
  readonly operation?: string;
  /**
   * Where the call keeps best-effort work running after its answer, the runtime's `waitUntil`; absent when
   * the runtime gives none.
   */
  readonly background?: BackgroundContext;
}
/** One scope, or several: any one of them admits the caller, or every one under `scopeMatch: 'all'`. */
export type OperationScope = string | readonly [string, ...string[]];

/** Whether an operation belongs in public contracts: the OpenAPI document and the discovery metadata. */
export function isPublicOperation(declaration: { visibility?: 'public' | 'internal' }): boolean {
  return declaration.visibility !== 'internal';
}

/** The scopes of an operation as a list. */
export function operationScopes(declaration: { scope: OperationScope }): readonly string[] {
  return typeof declaration.scope === 'string' ? [declaration.scope] : declaration.scope;
}

/**
 * Whether granted scopes admit an operation: any one of its scopes, or every one under `scopeMatch: 'all'`.
 * HTTP admission, MCP listing and calls, and execution share it.
 */
export function operationMatchesScopes(
  declaration: { scope: OperationScope; scopeMatch?: ScopeMatch },
  granted: readonly string[]
): boolean {
  return matchesScopes(operationScopes(declaration), granted, declaration.scopeMatch);
}

/**
 * Where and to whom an operation is reachable: its HTTP route, MCP tool and RPC method, each declared
 * explicitly, its visibility and the actors it admits.
 */
export interface Exposure {
  /** The principal kinds the operation admits: every kind when omitted. */
  actorKinds?: readonly Principal['actorKind'][];
  /** The HTTP route: its method, its versioned path and how its body and answer travel. */
  http?: {
    /** The route's method; only a read may use `GET`. */
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    /**
     * The versioned path template, such as `/v1/notes/{noteId}`, served below the HTTP handler's `basePath`.
     * A `{parameter}` fills a whole segment and names a required string input field.
     */
    path: string;
    /**
     * `bytes`: the body is raw bytes the handler reads on demand, and the input comes from the path, the
     * query string and `headers`. Not allowed on `GET`, nor on an operation that is also an MCP tool or RPC
     * method.
     */
    body?: 'bytes';
    /**
     * Input fields of a byte operation read from request headers, by field name:
     * `{ checksum: 'x-checksum' }`. The input schema decodes them; `authorization`, `cookie`, `host`,
     * `content-length` and `content-encoding` are never input.
     */
    headers?: Readonly<Record<string, string>>;
    /** `attachment`: the operation answers a file, its output `AttachmentOutputSchema`. HTTP-only. */
    response?: 'attachment';
    /** The status of a successful answer; 200 by default. */
    successStatus?: 200 | 201 | 202;
  };
  /**
   * `public` (the default) or `internal`, an operation for the service's own staff. An internal operation
   * stays routed and scope-checked like any other, but it is absent from the public OpenAPI document and from
   * the protected-resource `scopes_supported`; MCP lists it, as every tool, only to tokens that carry its
   * scope. Hiding is not authorization: the scope is what admits the caller.
   */
  visibility?: 'public' | 'internal';
  /**
   * The MCP tool: its unique name, whether repeating a call is safe (`idempotentHint`) and whether it reaches
   * outside the service (`openWorldHint`, default `true`).
   */
  mcp?: {
    /** The tool's unique name: a lowercase letter, then up to 63 letters, digits or underscores. */
    name: string;
    /** Whether repeating a call is safe, published as the tool's `idempotentHint`. */
    idempotent: boolean;
    /** Whether the tool reaches outside the service, published as its `openWorldHint`; `true` when absent. */
    openWorld?: boolean;
  };
  /**
   * The native RPC method: `true` admits every caller in the application's `rpc.callers`, `{ callers }` only
   * the listed ones among them.
   */
  rpc?: true | { callers: readonly string[] };
}
/**
 * An operation as an application holds it: its scope, words, effect, schemas, limits, exposure and handler.
 */
export interface OperationShape extends Exposure {
  /**
   * The scope a caller needs, `<namespace>:<resource>:<action>`. Several scopes mean any one of them admits
   * the caller (`['notes:notes:read', 'notes:notes:write']`: a write grant also reads), unless `scopeMatch`
   * is `all`. Published as OpenAPI security requirements: one per scope, or one with every scope under `all`.
   */
  scope: OperationScope;
  /** How several scopes admit a caller: `any` (the default) needs one of them, `all` needs every one. */
  scopeMatch?: ScopeMatch;
  /**
   * Scopes the handler checks itself, against `authority.scopes`, for particular resources or fields:
   * namespaced, listed once and distinct from the scopes that admit the call. A call without `authority`,
   * such as one over RPC or with a token that names no client, is refused with `FORBIDDEN` before it runs.
   */
  conditionalScopes?: readonly string[];
  /**
   * The domain failure codes the operation may answer, besides the standard ones every operation may.
   * Declared, they are all its documents list, and any other domain failure it returns, from its context,
   * middleware or handler, becomes INTERNAL_ERROR and is reported. Omitted, every failure of the catalog is
   * listed and allowed.
   */
  failures?: readonly string[];
  /** A short human name: the OpenAPI `summary` and the MCP tool's title. */
  title: string;
  /**
   * What the operation does, for people and agents: the OpenAPI `description` and the MCP tool's description.
   */
  description: string;
  /** The OpenAPI tag; defaults to the operation's name. */
  group?: string;
  /**
   * Whether the operation reads, writes or deletes: only a read may use `GET`, and the MCP read-only and
   * destructive hints follow it.
   */
  effect: 'read' | 'write' | 'delete';
  /**
   * The schema each call's input is decoded against: a strict object, or a union of strict objects except on
   * `GET`.
   */
  input: TSchema;
  /**
   * The schema every successful value is checked against: a strict object, a union of strict objects or
   * `AttachmentOutputSchema`.
   */
  output: TSchema;
  /**
   * The largest request body this operation accepts, in bytes: its JSON body, or its byte body under
   * `http.body: 'bytes'`. A larger one answers `REQUEST_TOO_LARGE`. Defaults to the application's
   * `maxBodyBytes` (32 KiB by default). Raise it only for operations whose input is legitimately large (a CSV
   * import, a document), never application-wide; the ceiling is 16 MiB. Not allowed on GET operations, whose
   * input is the query string.
   */
  maxBodyBytes?: number;
  /**
   * The largest output this operation answers, in bytes: its value's JSON, or an attachment's `byteLength`.
   * Defaults to the application's `maxOutputBytes` (256 KiB by default), up to 16 MiB. A larger output is the
   * server's error, `INTERNAL_ERROR`.
   */
  maxOutputBytes?: number;
  /** The handler: it receives the prepared context and the decoded input and returns a `Result`. */
  execute: (context: never, input: never) => unknown;
  /**
   * The context preparation and middleware the builder captured when the operation was declared, so each
   * mounted module keeps its own; without it, execution uses the application's `context` and `middleware`.
   */
  pipeline?: {
    /** Prepares the call's context from its invocation; a failure it returns answers the call. */
    context: (invocation: never) => Promise<Result<unknown, Failure>>;
    /** The middleware that wraps the handler, in the order it runs. */
    middleware: readonly OperationMiddleware<never>[];
  };
}
/**
 * The fields of an operation's definition besides its exposure, as `.operation()` takes them: its scope,
 * words, effect, failures, schemas and limits.
 */
export type OperationFields<I extends TSchema, O extends TSchema> = Omit<
  OperationShape,
  keyof Exposure | 'input' | 'output' | 'execute' | 'pipeline'
> & {
  input: I;
  output: O;
};
/** A definition with the exposure its declaration names, keeping that exposure's literal types. */
export type OperationDefinition<I extends TSchema, O extends TSchema, X> = X & OperationFields<I, O>;
/** What a handler receives besides its input: the prepared context and, for a declared byte body, its reader. */
export type OperationContext<C, X> = C &
  (X extends { http: { body: 'bytes' } } ? { body: BinaryBody } : object);
/** An operation's handler: the prepared context and the decoded input in, a Result of its output out. */
export type OperationHandler<C, I extends TSchema, O extends TSchema, X> = (
  context: OperationContext<C, X>,
  input: StaticDecode<I>
) => Promise<Result<Static<O>, Failure>>;
/**
 * Declares one operation on its own, keeping its literal types. The builder's `.operation()` is the usual way
 * to declare one. As there, `execute` receives the decoded input, `StaticDecode<typeof input>`.
 */
export function operation<C, I extends TSchema, O extends TSchema, const X extends Exposure>(
  definition: OperationDefinition<I, O, X> & { execute: OperationHandler<C, I, O, X> }
) {
  return definition;
}
/** The intersection of a union's members: the operations of every composed group. */
type Intersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void
  ? I
  : never;
/**
 * Merges groups of operations into one, never overwriting: a name two groups declare throws a TypeError,
 * `Duplicate operation: <name>`.
 */
export function composeOperations<const G extends readonly Record<string, OperationShape>[]>(
  ...groups: G
): Intersection<G[number]> {
  const result: Record<string, OperationShape> = {};
  for (const group of groups) {
    for (const [name, op] of Object.entries(group)) {
      if (Object.hasOwn(result, name)) {
        throw new TypeError(`Duplicate operation: ${name}`);
      }
      Object.defineProperty(result, name, { value: op, enumerable: true });
    }
  }
  return result as Intersection<G[number]>;
}
/**
 * Code that wraps an operation after admission and preparation: it receives the context and `next`, which
 * runs the rest of the chain and the handler, and returns a Result. It calls `next` at most once: a second
 * call rejects.
 */
export type OperationMiddleware<C> = (
  context: C,
  next: () => Promise<Result<unknown, Failure>>
) => Promise<Result<unknown, Failure>>;
/** A Markdown usage guide, served over MCP as a resource and a reusable prompt. */
export interface McpGuide {
  /**
   * The guide's unique name, `^[a-z][a-z0-9-]{0,63}$`: its prompt's name and the end of its resource URI,
   * `<origin>/guides/<name>`.
   */
  name: string;
  /** The guide's human title, shown on its resource and its prompt. */
  title: string;
  /** The guide's Markdown: the resource's content and the prompt's message. */
  text: string;
}
/**
 * An Agent Skill served through the MCP Skills extension (`io.modelcontextprotocol/skills`) as
 * `skill://<name>/SKILL.md`, whose frontmatter is generated from `name` and `description`. Skills are
 * static guidance shared by every caller: never put tenant data in them, and they grant no tool or scope.
 */
export interface McpSkill {
  /** Lowercase letters and digits joined by single hyphens, at most 64 characters; also the skill directory. */
  name: string;
  /** One line of at most 1024 characters: what the workflow achieves and when to use it. */
  description: string;
  /** The Markdown instructions that follow the frontmatter. */
  text: string;
}
/** The MCP server's own description: instructions for clients, guides, skills and an optional skill tool. */
export interface McpConfiguration {
  /** Server guidance returned when a client connects. */
  instructions?: string;
  /** Markdown usage guides, each served as a resource and as a prompt. */
  guides?: readonly McpGuide[];
  /**
   * Agent Skills served through the MCP Skills extension as `skill://<name>/SKILL.md`, the same for every
   * caller.
   */
  skills?: readonly McpSkill[];
  /**
   * Also serve the skills through one read-only tool with this name, for clients that import only tools.
   * Omit it to keep skills out of the tool catalog.
   */
  skillTool?: string;
}
/**
 * A built application: its identity, token policy, error catalog, operations and the configuration every
 * transport reads.
 */
export interface AppManifest<Env, C, Ops extends Record<string, OperationShape>> {
  /**
   * The service's identifier, a lowercase kebab-case word of 2 to 64 characters: the MCP server name and the
   * `service` that `/health` and telemetry report.
   */
  name: string;
  /** The prefix of every scope, `<namespace>:<resource>:<action>`; it matches `^[a-z][a-z0-9-]{1,63}$`. */
  namespace: string;
  /** The service's human name: OpenAPI `info.title`, the MCP server title and the OAuth `resource_name`. */
  title: string;
  /**
   * The service's version: OpenAPI `info.version`, the MCP server version and the `version` that `/health`
   * reports.
   */
  version: string;
  /** The service's public HTTPS base URL, which OpenAPI, MCP resources and OAuth discovery advertise. */
  origin: string;
  /**
   * How bearer tokens are verified and documented: their audiences, the OAuth issuer and JWKS, or the
   * application's own `resolve`.
   */
  tokens: TokenPolicy<Env>;
  /** The catalog `defineErrors()` returns; every failure a call answers is validated against it. */
  errors: ErrorCatalog;
  /**
   * The middleware `.use()` added, in the order it runs; each wraps a call after admission and context
   * preparation.
   */
  middleware?: readonly OperationMiddleware<C>[];
  /**
   * Prepares a call's context from its invocation with what each `.derive()` adds; a failure it returns
   * answers the call.
   */
  context: (invocation: Invocation<Env>) => Promise<Result<C, Failure>>;
  /**
   * The application's operations by name; each name is also its OpenAPI `operationId` and native RPC method.
   */
  operations: Ops;
  /**
   * The Workers allowed to call native RPC methods, by the `caller` their Service Binding props name; `[]`
   * for none.
   */
  rpc: { callers: readonly string[] };
  /**
   * Whether diagnostics and observers run, the observers that receive execution and admission events, and
   * where the trace id comes from.
   */
  telemetry?: TelemetryConfig<Env>;
  /**
   * A Workers rate limiting binding each HTTP and MCP call must pass, per organization and actor; each
   * message of an MCP batch counts as a call. A refusal answers `RATE_LIMITED`.
   */
  rateLimit?: {
    /** The name of the rate limiting binding in the env. */
    binding: keyof Env;
    /** The `Retry-After` seconds a refusal sends; 60 by default. */
    retryAfter?: number;
  };
  /**
   * The request body limit, in bytes, of every operation that sets none: 32 KiB by default, at most 16 MiB.
   */
  maxBodyBytes?: number;
  /** The output limit, in bytes, of every operation that sets none: 256 KiB by default, at most 16 MiB. */
  maxOutputBytes?: number;
  /** The MCP server's instructions, guides and skills; setting it requires the MCP transport. */
  mcp?: McpConfiguration;
}
/** The failure codes every operation may answer without declaring them. */
export const STANDARD_CODES: ReadonlySet<string> = new Set(
  Object.values(STANDARD_FAILURES as Record<string, { code: string }>).map(({ code }) => code)
);

/** Default request body limit when neither the operation nor the application sets one. */
export const DEFAULT_MAX_BODY_BYTES = 32_768;
/** Default output limit when neither the operation nor the application sets one. */
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
/** Largest body limit an application or operation may declare: the body is buffered in memory. */
export const MAX_BODY_BYTES_CEILING = 16 * 1024 * 1024;

/** The request body limit an operation is held to: its own, else the application's, else the default. */
export function operationBodyLimit(
  application: { maxBodyBytes?: number },
  declaration: { maxBodyBytes?: number }
): number {
  return declaration.maxBodyBytes ?? application.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
}

/** The output limit an operation is held to: its own, else the application's, else the default. */
export function operationOutputLimit(
  application: { maxOutputBytes?: number },
  declaration: { maxOutputBytes?: number }
): number {
  return declaration.maxOutputBytes ?? application.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
}

/** Whether an operation's MCP tool reaches outside the service: it does unless it declares otherwise. */
export function mcpOpenWorld(tool: { openWorld?: boolean }): boolean {
  return tool.openWorld ?? true;
}
