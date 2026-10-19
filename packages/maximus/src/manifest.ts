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

/** Transport-verified authority, separate from the unchanged ordinary RPC principal. */
export interface InvocationAuthority {
  /** The transport whose admission verified the token, such as `http` or `mcp`. */
  readonly surface: 'http' | 'mcp';
  /** The scopes the verified token grants, which a handler checks its `conditionalScopes` against. */
  readonly scopes: readonly string[];
  /** The OAuth client the verified token was issued to: its id and its class, `human`, `machine` or `dcr`. */
  readonly client: Readonly<TokenClient>;
  /**
   * The bearer token the call was admitted with, verified: on an HTTP or MCP call to the service's origin,
   * including one a gateway forwards. It is the caller's OAuth access token, unless
   * `tokens.resolve` admitted another credential (a workload key under `oauth+bearer`) or it is the
   * development token; absent under the application's own `bearer` scheme. For an owner that calls another
   * service as the same caller, which verifies it again. Never log, store or return it.
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
  /** Available only to explicitly declared HTTP byte-body operations. */
  readonly body?: BinaryBody;
  /**
   * The verified caller: its actor, actor kind, organization and request id. Scope every tenant query by its
   * `organizationId`.
   */
  principal: Principal;
  /**
   * The verified token's surface, scopes and client, on HTTP and MCP calls whose token names a client; absent
   * over ordinary RPC.
   */
  readonly authority?: InvocationAuthority;
  /** Already decoded operation input; preparation must not re-validate or log it. */
  readonly input?: unknown;
  /** Builder-owned operation identifier, never taken from caller input. */
  readonly operation?: string;
  /** Bounded best-effort work attached to the invoking runtime. */
  readonly background?: BackgroundContext;
}
/** One scope, or several of which any one admits the caller. */
export type OperationScope = string | readonly [string, ...string[]];

/** Whether an operation belongs in public contracts (OpenAPI, typed clients, discovery metadata). */
export function isPublicOperation(declaration: { visibility?: 'public' | 'internal' }): boolean {
  return declaration.visibility !== 'internal';
}

/** The scopes of an operation as a list; a caller needs any one of them. */
export function operationScopes(declaration: { scope: OperationScope }): readonly string[] {
  return typeof declaration.scope === 'string' ? [declaration.scope] : declaration.scope;
}

/** Shared by HTTP admission, MCP discovery and calls, and execution. */
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
  /** Eligible principal kinds; omitted only for legacy contracts. */
  actorKinds?: readonly Principal['actorKind'][];
  /** Versioned route; required string input fields may occupy complete {parameter} segments. */
  http?: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    body?: 'bytes';
    /** Input metadata fields sourced from explicit HTTP headers, decoded by the input schema. */
    headers?: Readonly<Record<string, string>>;
    response?: 'attachment';
    successStatus?: 200 | 201 | 202;
  };
  /**
   * `internal`: an operation for the service's own staff. It stays routed and
   * scope-checked like any other, but it is absent from the public OpenAPI
   * document, from the protected-resource `scopes_supported` and from the
   * typed client; MCP lists it only to tokens that carry its scope. Hiding is
   * not authorization: the scope is what admits the caller.
   */
  visibility?: 'public' | 'internal';
  /**
   * The MCP tool: its unique name, whether repeating a call is safe (`idempotentHint`) and whether it reaches
   * outside the service (`openWorldHint`, default `true`).
   */
  mcp?: { name: string; idempotent: boolean; openWorld?: boolean };
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
   * The scope a caller needs. Several scopes mean any one of them admits the
   * caller (`['notes:notes:read', 'notes:notes:write']`: a write grant
   * also reads). Published as alternative OpenAPI security requirements.
   */
  scope: OperationScope;
  /** Arrays retain any-of semantics unless the owner explicitly declares all-of. */
  scopeMatch?: ScopeMatch;
  /** Owner handlers select conditional scopes for the actual resource/fields. Absence of authority fails closed. */
  conditionalScopes?: readonly string[];
  /**
   * The domain failure codes the operation may answer, besides the standard ones every operation may.
   * Declared, they are all its documents list, and any other domain failure it returns becomes
   * INTERNAL_ERROR and is reported. Omitted, every failure of the catalog is listed and allowed.
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
   * Largest JSON request body this operation accepts, in bytes. Defaults to
   * the application's `maxBodyBytes` (32 KiB). Raise it only for operations
   * whose input is legitimately large (a CSV import, a document), never
   * application-wide; the ceiling is 16 MiB. Not allowed on GET operations,
   * whose input is the query string.
   */
  maxBodyBytes?: number;
  /** Exact attachment/JSON output byte bound, up to 16 MiB; otherwise inherits the application bound. */
  maxOutputBytes?: number;
  /** The handler: it receives the prepared context and the decoded input and returns a `Result`. */
  execute: (context: never, input: never) => unknown;
  /** Captured by the fluent builder; each mounted group owns its inferred preparation and middleware. */
  pipeline?: {
    context: (invocation: never) => Promise<Result<unknown, Failure>>;
    middleware: readonly OperationMiddleware<never>[];
  };
}
/**
 * Declares one operation on its own, keeping its literal types. The builder's `.operation()` is the usual way
 * to declare one. As there, `execute` receives the decoded input, `StaticDecode<typeof input>`.
 */
export function operation<C, I extends TSchema, O extends TSchema, const X extends Exposure>(
  definition: X & {
    scope: OperationScope;
    scopeMatch?: ScopeMatch;
    conditionalScopes?: readonly string[];
    title: string;
    description: string;
    group?: string;
    effect: OperationShape['effect'];
    input: I;
    output: O;
    execute: (context: C, input: StaticDecode<I>) => Promise<Result<Static<O>, Failure>>;
  }
) {
  return definition;
}
/** The intersection of a union's members: the operations of every composed group. */
type Intersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void
  ? I
  : never;
/** Compose resource modules without silently overwriting a capability. */
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
 * Code that wraps an operation after admission and preparation: it receives the context and `next`, which it
 * may call once, and returns a Result.
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
  /** The service's identifier: the MCP server name and the `service` that `/health` and telemetry report. */
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
   * A Workers rate limiting binding each HTTP and MCP call must pass, per organization and actor;
   * `retryAfter` sets a refusal's `Retry-After` seconds, 60 by default.
   */
  rateLimit?: { binding: keyof Env; retryAfter?: number };
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
