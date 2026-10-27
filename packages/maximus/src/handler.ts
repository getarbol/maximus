/**
 * Declarations a project binds to its application: `defineHandler` for a route whose path and method come
 * from its filename, `defineTool` for a tool only MCP serves, named by its file, and `defineContext` and
 * `defineAuth` for the context every handler receives and the tokens the application verifies itself. A
 * route or tool takes its handler first and its contract after it; each is a plain value, and binding
 * derives what it leaves out (its name, scope, effect and title) and runs it through the same execution
 * path as every other operation.
 */
import { KindGuard, Type } from '@sinclair/typebox';
import type { Static, TObject, TProperties, TSchema } from '@sinclair/typebox';

import type { BodyFailure } from './binary.ts';
import type { ApplicationBuilder } from './builder.ts';
import type { CreateArguments, ErrorDefinition, Failure, standardErrors } from './errors.ts';
import type { Exposure, Invocation, OperationShape } from './manifest.ts';
import type { Result } from './result.ts';
import type { StaticDecode } from './schema-types.ts';
import type { STANDARD_FAILURES } from './standard-failures.ts';
import type { TokenPolicy } from './tokens.ts';

declare global {
  /**
   * What a project registers about its application, so every handler is typed without importing it:
   * `base`, the builder its routes bind to, `errors`, its error catalog, and `env`, its Worker's bindings.
   * `maximus prepare` writes the registration in `.maximus/register.d.ts`; without one, handlers receive
   * the bare invocation and fail with standard failures. Global, so it merges however the package's
   * declarations are bundled.
   */
  interface MaximusRegister {}
}

/**
 * A registered member, or its fallback when the project registers none. Only that member is read: the base
 * depends on `context.ts`, whose types read the registered bindings.
 */
type Registered<K extends string, Fallback> = K extends keyof MaximusRegister ? MaximusRegister[K] : Fallback;
/** The registered Worker's bindings. */
type RegisteredEnv = Registered<'env', unknown>;
/** The context every handler receives: what the registered base prepares. */
type RegisteredContext =
  Registered<'base', never> extends ApplicationBuilder<infer _E, infer C, infer _O> ? C : Invocation<unknown>;
/** The definitions of the registered error catalog. */
type CatalogDefinitions =
  Registered<'errors', typeof standardErrors> extends { definitions: infer D } ? D : never;
/** Every code of the registered catalog: literal codes, or `string` for a catalog typed as `ErrorCatalog`. */
type CatalogCode = {
  [K in keyof CatalogDefinitions]: CatalogDefinitions[K] extends { code: infer C extends string } ? C : never;
}[keyof CatalogDefinitions];
/** The code of every standard failure, which any operation may answer without declaring it. */
type StandardCode = (typeof STANDARD_FAILURES)[keyof typeof STANDARD_FAILURES]['code'];
/** The codes a declaration may list in `failures`: the catalog's own. */
export type DomainCode = Exclude<CatalogCode, StandardCode>;
/** The definition of the registered catalog that has this code. */
type DefinitionWithCode<Code> = Extract<
  {
    [K in keyof CatalogDefinitions]: CatalogDefinitions[K] extends { code: Code }
      ? CatalogDefinitions[K]
      : never;
  }[keyof CatalogDefinitions],
  ErrorDefinition
>;
/** What `fail` takes after the code: the data the code declares, or any data when codes are untyped. */
type FailureArguments<Code extends string> = string extends CatalogCode
  ? [data?: Readonly<Record<string, unknown>>]
  : CreateArguments<DefinitionWithCode<Code>>;
/** The codes a handler may fail with: the domain failures it declares, or every one, and the standard ones. */
type AllowedCode<X> =
  | (X extends { failures: readonly (infer C extends string)[] } ? C : DomainCode)
  | StandardCode;

/**
 * A failure a handler answers with, `return fail('TASK_NOT_FOUND')`: an expected outcome, never thrown. Only
 * `fail` creates one.
 */
export class Failed<Code extends string = string> {
  /** Keeps the class nominal: an object of the same shape is not a failure. */
  declare private readonly nominal: never;
  /** The catalog failure the call answers. */
  readonly failure: Failure & { code: Code };
  constructor(failure: Failure & { code: Code }) {
    this.failure = failure;
  }
  /** Whether a handler's answer is a failure rather than its output. */
  static is(value: unknown): value is Failed {
    return value instanceof Failed;
  }
}
/** Answers a failure of the catalog by its code, with the data the code declares. */
export type Fail<Codes extends string> = <const Code extends Codes>(
  code: Code,
  ...data: FailureArguments<Code>
) => Failed<Code>;

/** A schema, or the fields of a strict object schema. */
export type SchemaOrFields = TSchema | TProperties;
/** The schema `input` or `output` stands for: itself, or the strict object of its fields. */
export type SchemaOf<S> = S extends TSchema ? S : S extends TProperties ? TObject<S> : never;
/** The schema `input` or `output` stands for, as `SchemaOf` types it: no fields is an empty strict object. */
export function schemaOf(value: SchemaOrFields | undefined): TSchema {
  if (value === undefined) {
    return Type.Object({}, { additionalProperties: false });
  }
  return KindGuard.IsSchema(value) ? value : Type.Object(value, { additionalProperties: false });
}

/** A field a declaration names, or none when it leaves the field out (its type parameter stays `never`). */
type Field<K extends string, T> = [T] extends [never] ? unknown : Record<K, T>;
/**
 * The fields of a declaration its types depend on, as it names them: its failures, HTTP options, MCP tool,
 * RPC exposure, effect, visibility and operation id.
 */
export type DeclaredFields<F, H, M, R, E, V, N> = Field<'failures', F> &
  Field<'http', H> &
  Field<'mcp', M> &
  Field<'rpc', R> &
  Field<'effect', E> &
  Field<'visibility', V> &
  Field<'operationId', N>;

/**
 * A route's byte body, read on demand once the route has admitted its target: its bytes, or the failure the
 * route answers as it is, `if (!bytes.ok) return bytes.error`.
 */
export interface RouteBody {
  /**
   * Reads the body, once, within the route's `maxBodyBytes`: `REQUEST_TOO_LARGE` beyond it,
   * `UNSUPPORTED_MEDIA_TYPE` for a compressed body and `INVALID_INPUT` for one that broke off.
   */
  read: () => Promise<Result<Uint8Array<ArrayBuffer>, Failed<BodyFailure['code']>>>;
}

/** What a handler receives: the prepared context, its decoded input, `fail` and, for a byte body, its reader. */
export type HandlerArguments<C, I extends TSchema, X> = Omit<C, 'input' | 'body'> & {
  /** The input, decoded against its schema. */
  readonly input: StaticDecode<I>;
  /** Answers a failure of the catalog: `return fail('TASK_NOT_FOUND')`. */
  readonly fail: Fail<AllowedCode<X>>;
} & (X extends { http: { body: 'bytes' } } ? { readonly body: RouteBody } : unknown);
/** What a handler answers: its output, or a failure from `fail`, at once or as a promise. */
export type HandlerAnswer<O extends TSchema, X> = Answer<Static<O>, X>;
/** A value, or a failure from `fail`, at once or as a promise. */
type Answer<V, X> = V | Failed<AllowedCode<X>> | Promise<V | Failed<AllowedCode<X>>>;
/** The empty strict object a route answers when it declares no output. */
type NoOutput = TObject<Record<never, never>>;
/** The output schema a declaration stands for: the one it declares, or the empty object. */
type OutputSchema<O> = [O] extends [never] ? NoOutput : SchemaOf<O>;
/**
 * What a handler that declares no output returns: nothing, or the empty object. An async handler without a
 * return statement answers `Promise<void>`, which `undefined` would refuse.
 */
// oxlint-disable-next-line typescript/no-invalid-void-type -- a route without output returns nothing.
type Nothing = Record<string, never> | void;
/** What a handler returns: its declared output or, when it declares none, nothing at all. */
type OutputValue<O> = [O] extends [never] ? Nothing : Static<SchemaOf<O>>;

/** The HTTP options a route may set: its path and method come from its filename. */
export type HandlerHttp = Omit<NonNullable<Exposure['http']>, 'method' | 'path'>;
/** A route's MCP tool: its name and, when they differ from its method's, its hints. */
export interface HandlerMcp {
  /** The tool's name, unique in the application: a letter, then letters, digits and underscores. */
  name: string;
  /** Whether repeating a call is safe; by default, as its HTTP method is (GET, PUT and DELETE are). */
  idempotent?: boolean;
  /** Whether the tool reaches outside the service; `true` unless declared. */
  openWorld?: boolean;
}
/**
 * A route's contract, what `defineHandler` takes after the handler: its schemas and the fields it declares,
 * each derived or empty when left out. A contract kept in a `const` keeps its types with
 * `satisfies HandlerOptions`; an annotation would widen them.
 */
export interface HandlerOptions {
  /** The input schema, or its fields; none when the route takes no input. */
  input?: SchemaOrFields;
  /** The output schema, or its fields; none when the route answers the empty object. */
  output?: SchemaOrFields;
  /** A short human name: the OpenAPI `summary` and the MCP tool's title. By default, the method and path. */
  title?: string;
  /** What the route does, for people and agents. A route that is also an MCP tool requires it. */
  description?: string;
  /** The OpenAPI tag; by default, the operation's name. */
  group?: string;
  /** The OpenAPI `operationId` and native RPC method: by default, the method and path in camelCase. */
  operationId?: string;
  /**
   * The scope a caller needs: by default, `<namespace>:<resource>:read` for a read and
   * `<namespace>:<resource>:write` otherwise, the resource being the first fixed segment after the version.
   */
  scope?: OperationShape['scope'];
  /** Whether several scopes are alternatives (`any`, the default) or all required. */
  scopeMatch?: OperationShape['scopeMatch'];
  /** Scopes the handler checks for particular resources or fields, besides the one that admits the call. */
  conditionalScopes?: OperationShape['conditionalScopes'];
  /** Whether it reads, writes or deletes: by default, GET reads, DELETE deletes and the rest write. */
  effect?: OperationShape['effect'];
  /** The domain failure codes it may answer, besides the standard ones; every one when omitted. */
  failures?: readonly DomainCode[];
  /** The principal kinds it admits. */
  actorKinds?: Exposure['actorKinds'];
  /** `internal` keeps it out of the public OpenAPI document and the discovery metadata. */
  visibility?: Exposure['visibility'];
  /** The HTTP options besides the path and method: a byte body, header-sourced fields, an attachment. */
  http?: HandlerHttp;
  /** Also serve the route as an MCP tool with this name. */
  mcp?: HandlerMcp;
  /** Also serve it as a native RPC method, to every allowed caller or to the listed ones. */
  rpc?: Exposure['rpc'];
  /** The largest JSON request body it accepts, in bytes. */
  maxBodyBytes?: number;
  /** The largest output it answers, in bytes. */
  maxOutputBytes?: number;
}

/** Every declaration `defineHandler` returned, so binding refuses any other value. */
const handlers = new WeakSet<object>();
/** Every declaration `defineTool` returned. */
const tools = new WeakSet<object>();

/**
 * A route as `defineHandler` declares it, before binding gives it a path and a method. `X` holds the fields
 * its types depend on; `C` is the context its handler expects, the registered one, which the base it binds
 * to must prepare.
 */
export interface HandlerDeclaration<I extends TSchema, O extends TSchema, X, C = RegisteredContext> {
  /** The fields the route declares besides its schemas. */
  readonly options: Omit<HandlerOptions, 'input' | 'output'>;
  /** The input schema; an empty strict object when the route declares none. */
  readonly input: I;
  /** The output schema. */
  readonly output: O;
  /** Answers one call. */
  readonly handler: (args: HandlerArguments<C, I, X>) => HandlerAnswer<O, X>;
}

/** The fields `defineHandler` types from its contract, as the contract names them. */
type HandlerContract<I, O, F, H, M, R, E, V, N> = Omit<
  HandlerOptions,
  'input' | 'output' | 'failures' | 'http' | 'mcp' | 'rpc' | 'effect' | 'visibility' | 'operationId'
> & {
  input?: I;
  output?: O;
  failures?: F;
  http?: H;
  mcp?: M;
  rpc?: R;
  effect?: E;
  visibility?: V;
  operationId?: N;
} & ([M] extends [never] ? unknown : { description: string });

/** Every handler declaration takes its handler first: an object there is a contract written in its place. */
function requireHandler(handler: unknown, helper: string): void {
  if (typeof handler !== 'function') {
    throw new TypeError(
      `${helper} takes the handler first and its contract after it: ${helper}(async ({ input }) => …, { input, output }).`
    );
  }
}

/**
 * The declaration's schemas and handler. A contract without `output` answers the empty object, so its
 * handler may return nothing.
 */
function declare(handler: (args: never) => unknown, contract: HandlerOptions) {
  const { input, output, ...options } = contract;
  return Object.freeze({
    options: Object.freeze(options),
    input: schemaOf(input),
    output: schemaOf(output),
    handler: output === undefined ? async (args: never) => (await handler(args)) ?? {} : handler,
  });
}

/**
 * Declares a route as its file's default export: its handler, then its contract. The filename gives its path
 * and method: `routes/v1/tasks/[taskId].delete.ts` answers `DELETE /v1/tasks/{taskId}`. The handler receives
 * one object, `{ input, principal, env, fail, …context }`, and returns its output or `fail(code)`. The
 * contract's `input` and `output` are schemas or the fields of strict objects; without a contract, the route
 * takes no input and answers the empty object.
 */
export function defineHandler<
  O extends SchemaOrFields = never,
  I extends SchemaOrFields = TObject<Record<never, never>>,
  const F extends readonly DomainCode[] = never,
  const H extends HandlerHttp = never,
  const M extends HandlerMcp = never,
  const R extends NonNullable<Exposure['rpc']> = never,
  const E extends OperationShape['effect'] = never,
  const V extends NonNullable<Exposure['visibility']> = never,
  const N extends string = never,
>(
  /** Answers one call: its output, or `fail(code)`. */
  handler: (
    args: HandlerArguments<RegisteredContext, SchemaOf<I>, DeclaredFields<F, H, M, R, E, V, N>>
  ) => Answer<OutputValue<O>, DeclaredFields<F, H, M, R, E, V, N>>,
  contract?: HandlerContract<I, O, F, H, M, R, E, V, N>
): HandlerDeclaration<SchemaOf<I>, OutputSchema<O>, DeclaredFields<F, H, M, R, E, V, N>> {
  requireHandler(handler, 'defineHandler');
  // `declare` builds the schemas `SchemaOf` and `OutputSchema` name: the ones given, or strict objects.
  const declaration = declare(handler, contract ?? {}) as unknown as HandlerDeclaration<
    SchemaOf<I>,
    OutputSchema<O>,
    DeclaredFields<F, H, M, R, E, V, N>
  >;
  handlers.add(declaration);
  return declaration;
}

/** A tool's contract, what `defineTool` takes after the handler: its schemas, description, effect and the rest. */
export interface ToolOptions extends Omit<
  HandlerOptions,
  'description' | 'effect' | 'operationId' | 'http' | 'mcp' | 'visibility'
> {
  /** What the tool does, for the agents that choose it. */
  description: string;
  /** Whether it reads, writes or deletes: its MCP hints and default scope follow it. */
  effect: OperationShape['effect'];
  /** Whether repeating a call is safe; by default, only a read is. */
  idempotent?: boolean;
  /** Whether the tool reaches outside the service; `true` unless declared. */
  openWorld?: boolean;
}

/** A tool as `defineTool` declares it, before binding names it after its file; `X` and `C` as for a route. */
export interface ToolDeclaration<I extends TSchema, O extends TSchema, X, C = RegisteredContext> {
  /** The fields the tool declares besides its schemas. */
  readonly options: Omit<ToolOptions, 'input' | 'output'>;
  /** The input schema; an empty strict object when the tool takes none. */
  readonly input: I;
  /** The output schema. */
  readonly output: O;
  /** Answers one call. */
  readonly handler: (args: HandlerArguments<C, I, X>) => HandlerAnswer<O, X>;
}

/**
 * Declares a tool only MCP serves, as its file's default export: its handler, then its contract.
 * `mcp/tools/summarize-tasks.ts` is the tool `summarize_tasks`. The contract states its description and
 * effect; its handler works as a route's.
 */
export function defineTool<
  const E extends OperationShape['effect'] = never,
  O extends SchemaOrFields = never,
  I extends SchemaOrFields = TObject<Record<never, never>>,
  const F extends readonly DomainCode[] = never,
  const R extends NonNullable<Exposure['rpc']> = never,
>(
  /** Answers one call: its output, or `fail(code)`. */
  handler: (
    args: HandlerArguments<
      RegisteredContext,
      SchemaOf<I>,
      DeclaredFields<F, never, never, R, E, never, never>
    >
  ) => Answer<OutputValue<O>, DeclaredFields<F, never, never, R, E, never, never>>,
  contract: Omit<ToolOptions, 'input' | 'output' | 'effect' | 'failures' | 'rpc'> & {
    input?: I;
    output?: O;
    failures?: F;
    rpc?: R;
  } & ([E] extends [never] ? { effect: OperationShape['effect'] } : { effect: E })
): ToolDeclaration<SchemaOf<I>, OutputSchema<O>, DeclaredFields<F, never, never, R, E, never, never>> {
  requireHandler(handler, 'defineTool');
  // `declare` builds the schemas `SchemaOf` and `OutputSchema` name: the ones given, or strict objects.
  const declaration = declare(handler, contract) as unknown as ToolDeclaration<
    SchemaOf<I>,
    OutputSchema<O>,
    DeclaredFields<F, never, never, R, E, never, never>
  >;
  tools.add(declaration);
  return declaration;
}

/** Whether a module's default export came from `defineHandler`. */
export function isHandlerDeclaration(value: unknown): boolean {
  return typeof value === 'object' && value !== null && handlers.has(value);
}
/** Whether a module's default export came from `defineTool`. */
export function isToolDeclaration(value: unknown): boolean {
  return typeof value === 'object' && value !== null && tools.has(value);
}

/** What preparing a call's context receives: the verified invocation and `fail`. */
export type ContextArguments<E = RegisteredEnv> = Invocation<E> & {
  /** Answers the call with a failure of the catalog instead of preparing its context. */
  readonly fail: Fail<DomainCode | StandardCode>;
};
/** Every declaration `defineContext` returned. */
const contexts = new WeakSet<object>();
/** The context every handler receives, as `defineContext` declares it; `E` is the registered bindings. */
export interface ContextDeclaration<D, E = RegisteredEnv> {
  /** Prepares one call's context from its invocation. */
  readonly prepare: (args: ContextArguments<E>) => D | Failed | Promise<D | Failed>;
}

/**
 * Declares, as `context.ts`'s default export, what every handler receives besides the invocation: it runs
 * once per call after admission and returns the values handlers destructure, such as a store scoped to
 * `principal.organizationId`, or `fail(code)` to answer the call instead. A route that lists its `failures`
 * answers a domain code of the context only when it lists that code too.
 */
export function defineContext<D extends object>(
  prepare: (args: ContextArguments) => D | Failed | Promise<D | Failed>
): ContextDeclaration<D> {
  const declaration = Object.freeze({ prepare });
  contexts.add(declaration);
  return declaration;
}
/**
 * The context a `context.ts` declaration prepares: the invocation and its values. Operation middleware is
 * typed with it, `defineOperationMiddleware<PreparedContext<typeof context>>`, importing the type alone.
 */
export type PreparedContext<T> =
  T extends ContextDeclaration<infer D, infer E> ? Invocation<E> & Exclude<D, Failed> : never;
/** Whether `context.ts`'s default export came from `defineContext`. */
export function isContextDeclaration(value: unknown): boolean {
  return typeof value === 'object' && value !== null && contexts.has(value);
}

/** The token fields an application states in code, as `auth.ts` declares them; the rest are configuration. */
export type AuthOptions<E = RegisteredEnv> = Pick<
  TokenPolicy<E>,
  'resolve' | 'resourceMetadataUrl' | 'resources'
>;
/** The fields `auth.ts` states: code. The issuer, audience, scheme and every other field are configuration. */
const AUTH_FIELDS: ReadonlySet<string> = new Set(['resolve', 'resourceMetadataUrl', 'resources']);
/**
 * Declares, as `auth.ts`'s default export, how the application verifies tokens itself: `resolve`, for a
 * token its configuration's issuer does not issue, and its OAuth resources. Verify every token
 * cryptographically and parse its principal strictly; the issuer, audience and scheme stay in configuration,
 * and any of them here is refused rather than allowed to override it.
 */
export function defineAuth<const A extends AuthOptions>(
  auth: A & Record<Exclude<keyof A, keyof AuthOptions>, never>
): A {
  const configured = Object.keys(auth).filter((field) => !AUTH_FIELDS.has(field));
  if (configured.length) {
    throw new TypeError(
      `auth.ts states how tokens are verified in code; configure ${configured.join(', ')} in vite.config.ts.`
    );
  }
  return Object.freeze(auth);
}
