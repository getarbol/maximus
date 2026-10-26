/**
 * Declarations a project binds to its application: `defineHandler` for a route whose path and method come
 * from its filename, and `defineTool` for a tool only MCP serves, named by its file. Each is a plain value;
 * binding derives what it leaves out (its name, scope, effect and title) and runs it through the same
 * execution path as every other operation.
 */
import { KindGuard, Type } from '@sinclair/typebox';
import type { Static, TObject, TProperties, TSchema } from '@sinclair/typebox';

import type { BinaryBody } from './binary.ts';
import type { ApplicationBuilder } from './builder.ts';
import type { CreateArguments, ErrorDefinition, Failure, standardErrors } from './errors.ts';
import type { Exposure, Invocation, OperationShape } from './manifest.ts';
import type { StaticDecode } from './schema-types.ts';
import type { STANDARD_FAILURES } from './standard-failures.ts';

/**
 * What a project registers about its application, so every handler is typed without importing it: `base`,
 * the builder its routes bind to, and `errors`, its error catalog. `maximus prepare` writes the
 * registration; without one, handlers receive the bare invocation and fail with standard failures.
 */
export interface Register {}

/** A registered member, or its fallback when the project registers none. */
type Registered<K extends string, Fallback> = Register extends Record<K, infer T> ? T : Fallback;
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

/** What a handler receives: the prepared context, its decoded input, `fail` and, for a byte body, its reader. */
export type HandlerArguments<C, I extends TSchema, X> = Omit<C, 'input'> & {
  /** The input, decoded against its schema. */
  readonly input: StaticDecode<I>;
  /** Answers a failure of the catalog: `return fail('TASK_NOT_FOUND')`. */
  readonly fail: Fail<AllowedCode<X>>;
} & (X extends { http: { body: 'bytes' } } ? { readonly body: BinaryBody } : unknown);
/** What a handler answers: its output, or a failure from `fail`, at once or as a promise. */
export type HandlerAnswer<O extends TSchema, X> =
  | Static<O>
  | Failed<AllowedCode<X>>
  | Promise<Static<O> | Failed<AllowedCode<X>>>;

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
/** The fields a route may declare besides its schemas and handler; each is derived when left out. */
export interface HandlerOptions {
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
  /** `internal` keeps it out of the public OpenAPI document and the typed client. */
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
  /** The fields the route declares besides its schemas and handler. */
  readonly options: HandlerOptions;
  /** The input schema; an empty strict object when the route declares none. */
  readonly input: I;
  /** The output schema. */
  readonly output: O;
  /** Answers one call. */
  readonly handler: (args: HandlerArguments<C, I, X>) => HandlerAnswer<O, X>;
}

/**
 * Declares a route as its file's default export. The filename gives its path and method:
 * `routes/v1/tasks/[taskId].delete.ts` answers `DELETE /v1/tasks/{taskId}`. `input` and `output` are schemas
 * or the fields of strict objects. The handler receives one object, `{ input, principal, env, fail,
 * …context }`, and returns its output or `fail(code)`.
 */
export function defineHandler<
  O extends SchemaOrFields,
  I extends SchemaOrFields = TObject<Record<never, never>>,
  const F extends readonly DomainCode[] = never,
  const H extends HandlerHttp = never,
  const M extends HandlerMcp = never,
  const R extends NonNullable<Exposure['rpc']> = never,
  const E extends OperationShape['effect'] = never,
  const V extends NonNullable<Exposure['visibility']> = never,
  const N extends string = never,
>(
  definition: Omit<
    HandlerOptions,
    'failures' | 'http' | 'mcp' | 'rpc' | 'effect' | 'visibility' | 'operationId'
  > & {
    /** The input schema, or its fields; none when the route takes no input. */
    input?: I;
    /** The output schema, or its fields. */
    output: O;
    failures?: F;
    http?: H;
    mcp?: M;
    rpc?: R;
    effect?: E;
    visibility?: V;
    operationId?: N;
    /** Answers one call: its output, or `fail(code)`. */
    handler: (
      args: HandlerArguments<RegisteredContext, SchemaOf<I>, DeclaredFields<F, H, M, R, E, V, N>>
    ) => HandlerAnswer<SchemaOf<O>, DeclaredFields<F, H, M, R, E, V, N>>;
  } & ([M] extends [never] ? unknown : { description: string })
): HandlerDeclaration<SchemaOf<I>, SchemaOf<O>, DeclaredFields<F, H, M, R, E, V, N>> {
  const { input, output, handler, ...options } = definition;
  const declaration = Object.freeze({
    options: Object.freeze(options),
    // `schemaOf` builds the schema `SchemaOf` names: the one given, or the strict object of its fields.
    input: schemaOf(input) as SchemaOf<I>,
    output: schemaOf(output) as SchemaOf<O>,
    handler,
  });
  handlers.add(declaration);
  return declaration;
}

/** The fields a tool may declare besides its schemas and handler. */
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
  /** The fields the tool declares besides its schemas and handler. */
  readonly options: ToolOptions;
  /** The input schema; an empty strict object when the tool takes none. */
  readonly input: I;
  /** The output schema. */
  readonly output: O;
  /** Answers one call. */
  readonly handler: (args: HandlerArguments<C, I, X>) => HandlerAnswer<O, X>;
}

/**
 * Declares a tool only MCP serves, as its file's default export: `mcp/tools/summarize-tasks.ts` is the tool
 * `summarize_tasks`. It states its description and effect; its handler works as a route's.
 */
export function defineTool<
  O extends SchemaOrFields,
  const E extends OperationShape['effect'],
  I extends SchemaOrFields = TObject<Record<never, never>>,
  const F extends readonly DomainCode[] = never,
  const R extends NonNullable<Exposure['rpc']> = never,
>(
  definition: Omit<ToolOptions, 'effect' | 'failures' | 'rpc'> & {
    /** The input schema, or its fields; none when the tool takes no input. */
    input?: I;
    /** The output schema, or its fields. */
    output: O;
    effect: E;
    failures?: F;
    rpc?: R;
    /** Answers one call: its output, or `fail(code)`. */
    handler: (
      args: HandlerArguments<
        RegisteredContext,
        SchemaOf<I>,
        DeclaredFields<F, never, never, R, E, never, never>
      >
    ) => HandlerAnswer<SchemaOf<O>, DeclaredFields<F, never, never, R, E, never, never>>;
  }
): ToolDeclaration<SchemaOf<I>, SchemaOf<O>, DeclaredFields<F, never, never, R, E, never, never>> {
  const { input, output, handler, ...options } = definition;
  const declaration = Object.freeze({
    options: Object.freeze(options),
    // `schemaOf` builds the schema `SchemaOf` names: the one given, or the strict object of its fields.
    input: schemaOf(input) as SchemaOf<I>,
    output: schemaOf(output) as SchemaOf<O>,
    handler,
  });
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
