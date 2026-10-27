/**
 * Binds file declarations to the application: a route takes its path and method from its filename, a tool
 * its name from its file, and `context.ts` prepares every call. What a route or tool leaves out is derived
 * here, once: its operation name, effect, scope, title and tool hints.
 */
import type { TSchema } from '@sinclair/typebox';

import type { ApplicationBuilder, KnownOperationFields } from '../builder.ts';
import type { ErrorCatalog } from '../errors.ts';
import { Failed, isContextDeclaration, isHandlerDeclaration, isToolDeclaration } from '../handler.ts';
import type {
  ContextDeclaration,
  HandlerDeclaration,
  HandlerOptions,
  ToolDeclaration,
  ToolOptions,
} from '../handler.ts';
import type { Exposure, Invocation, OperationDefinition, OperationHandler } from '../manifest.ts';
import { err, ok } from '../result.ts';

/** A route's HTTP method. */
type HttpMethod = NonNullable<Exposure['http']>['method'];
/** A segment or parameter name in PascalCase: `task-lists` and `task_lists` are `TaskLists`. */
type Word<S extends string> = S extends `{${infer Name}}`
  ? Word<Name>
  : S extends `${infer Head}-${infer Tail}`
    ? `${Word<Head>}${Word<Tail>}`
    : S extends `${infer Head}_${infer Tail}`
      ? `${Word<Head>}${Word<Tail>}`
      : Capitalize<S>;
/** Every segment of a path in PascalCase, joined. */
type PathWords<P extends string> = P extends `/${infer Segment}/${infer Rest}`
  ? `${Word<Segment>}${PathWords<`/${Rest}`>}`
  : P extends `/${infer Segment}`
    ? Word<Segment>
    : '';
/** A route's operation name: `POST /v1/tasks/{taskId}/complete` is `postV1TasksTaskIdComplete`. */
export type RouteName<M extends string, P extends string> = `${Lowercase<M>}${PathWords<P>}`;
/** A tool's operation name: the file `summarize-tasks` is `summarizeTasks`. */
export type ToolName<F extends string> = Uncapitalize<Word<F>>;
/** A tool's MCP name: the file `summarize-tasks` is `summarize_tasks`. */
export type ToolMcpName<F extends string> = F extends `${infer Head}-${infer Tail}`
  ? `${Head}_${ToolMcpName<Tail>}`
  : F;

/** A route's operation name: its `operationId`, else its method and path. */
type BoundRouteName<X, M extends string, P extends string> = X extends { operationId: infer N extends string }
  ? N
  : RouteName<M, P>;
/** A route's effect: the declared one, else its method's. */
type RouteEffect<X, M> = X extends { effect: infer E }
  ? E
  : M extends 'GET'
    ? 'read'
    : M extends 'DELETE'
      ? 'delete'
      : 'write';
/** The exposure a bound route keeps: what it declares, its path and method, and its effect. */
type BoundRoute<X, M extends HttpMethod, P extends string> = Pick<
  X,
  Extract<keyof X, 'actorKinds' | 'visibility' | 'rpc'>
> & {
  http: (X extends { http: infer H } ? H : unknown) & { method: M; path: P };
  effect: RouteEffect<X, M>;
} & (X extends { mcp: infer T } ? { mcp: T & { idempotent: boolean } } : unknown);
/** The exposure a bound tool keeps: what it declares, its effect and its MCP tool. */
type BoundTool<X, F extends string> = Pick<X, Extract<keyof X, 'actorKinds' | 'rpc' | 'effect'>> & {
  mcp: { name: ToolMcpName<F>; idempotent: boolean; openWorld?: boolean };
};

/** A route's effect when it declares none: GET reads, DELETE deletes and the other methods write. */
function methodEffect(method: HttpMethod): 'read' | 'write' | 'delete' {
  if (method === 'GET') {
    return 'read';
  }
  return method === 'DELETE' ? 'delete' : 'write';
}
/** The methods HTTP defines as idempotent: the default idempotent hint of a route's tool. */
const IDEMPOTENT_METHODS: ReadonlySet<HttpMethod> = new Set(['GET', 'PUT', 'DELETE']);

/** `complete_task` as `Complete task`: a tool's default title. */
function humanize(name: string): string {
  const words = name.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
/** A segment or parameter name in PascalCase, as `Word` types it. */
function word(segment: string): string {
  return segment
    .replace(/^\{(.*)\}$/, '$1')
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
/** A route's operation name, as `RouteName` types it. */
export function routeName(method: HttpMethod, path: string): string {
  return `${method.toLowerCase()}${path.split('/').filter(Boolean).map(word).join('')}`;
}
/** A tool's operation name, as `ToolName` types it. */
export function toolName(file: string): string {
  const name = word(file);
  return name.charAt(0).toLowerCase() + name.slice(1);
}
/** The resource a route's scope names by default: its first fixed segment after the version, in kebab-case. */
function routeResource(path: string): string | undefined {
  const segments = path.split('/').filter(Boolean);
  return segments
    .slice(/^v[1-9][0-9]*$/.test(segments[0] ?? '') ? 1 : 0)
    .find((segment) => !segment.startsWith('{'))
    ?.replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replaceAll('_', '-')
    .toLowerCase();
}

/**
 * The `fail` a declaration receives: the catalog's failure for a code, with the data the code declares. An
 * unknown code, or data its code refuses, throws, which the execution path reports as `INTERNAL_ERROR`.
 */
function catalogFail(errors: ErrorCatalog) {
  const names = new Map(Object.entries(errors.definitions).map(([name, { code }]) => [code, name]));
  return (code: string, data?: unknown) => {
    const factory: unknown = Reflect.get(errors, names.get(code) ?? '');
    if (
      typeof factory !== 'object' ||
      factory === null ||
      !('create' in factory) ||
      typeof factory.create !== 'function'
    ) {
      throw new TypeError(`The error catalog has no failure ${code}.`);
    }
    return new Failed(factory.create(data));
  };
}

/**
 * Runs a declaration's handler as an operation: its output answers a success and `fail(code)` the catalog's
 * failure. The execution path checks the declared failures and the output once, as for every operation.
 */
function execute(errors: ErrorCatalog, handler: (args: never) => unknown) {
  const fail = catalogFail(errors);
  return async (context: object, input: unknown) => {
    const answer = await (handler as (args: object) => unknown)({ ...context, input, fail });
    return Failed.is(answer) ? err(answer.failure) : ok(answer);
  };
}

/**
 * Prepares every call's context with `context.ts`'s declaration, after admission: what it returns joins the
 * context, and `fail(code)` answers the call. The base must not declare operations yet.
 */
export function bindContext<E, D extends object>(
  base: ApplicationBuilder<E, Invocation<E>, Record<never, never>>,
  declaration: ContextDeclaration<D, E>
) {
  if (!isContextDeclaration(declaration)) {
    throw new TypeError("context.ts's default export must come from defineContext.");
  }
  const fail = catalogFail(base.definition.errors);
  type Prepared = Parameters<typeof declaration.prepare>[0];
  return base.derive(async (invocation) => {
    // `fail` answers any catalog code, which `Fail` narrows to the registered ones in the declaration's type.
    const answer = await declaration.prepare({ ...invocation, fail } as Prepared);
    return Failed.is(answer) ? err(answer.failure) : ok(answer);
  });
}

/**
 * Binds a `defineHandler` declaration to the application, under the path and method its filename gives. The
 * operation is named by its `operationId`, else by its method and path.
 */
export function bindRoute<
  E,
  C,
  I extends TSchema,
  O extends TSchema,
  X,
  const P extends string,
  const M extends HttpMethod,
>(
  base: ApplicationBuilder<E, C, Record<never, never>>,
  declaration: HandlerDeclaration<I, O, X, C>,
  path: P,
  method: M
) {
  if (!isHandlerDeclaration(declaration)) {
    throw new TypeError(`${method} ${path}: a route file's default export must come from defineHandler.`);
  }
  const {
    operationId,
    effect = methodEffect(method),
    scope,
    title,
    description = '',
    http,
    mcp,
    ...options
  }: HandlerOptions = declaration.options;
  const resource = routeResource(path);
  if (scope === undefined && resource === undefined) {
    throw new TypeError(`${method} ${path}: no fixed segment names its scope; declare its scope.`);
  }
  if (mcp && !description.trim()) {
    throw new TypeError(`${method} ${path}: a route that is an MCP tool describes what it does.`);
  }
  if (method === 'DELETE' && effect === 'read') {
    throw new TypeError(
      `${method} ${path}: a DELETE route deletes; its effect is delete or write, never read.`
    );
  }
  type Bound = BoundRoute<X, M, P>;
  type Name = BoundRouteName<X, M, P>;
  const definition = {
    ...options,
    title: title ?? (mcp ? humanize(mcp.name) : `${method} ${path}`),
    description,
    effect,
    scope: scope ?? `${base.definition.namespace}:${resource}:${effect === 'read' ? 'read' : 'write'}`,
    input: declaration.input,
    output: declaration.output,
    http: { ...http, method, path },
    ...(mcp ? { mcp: { ...mcp, idempotent: mcp.idempotent ?? IDEMPOTENT_METHODS.has(method) } } : {}),
  };
  return base.operation<Name, I, O, Bound>(
    // `routeName` derives at runtime the name `RouteName` derives in the type.
    (operationId ?? routeName(method, path)) as Name,
    // The declaration's fields, which its own type checked, and the derived ones; `.build()` still refuses
    // any field no operation has.
    definition as unknown as OperationDefinition<I, O, Bound> & KnownOperationFields<Bound>,
    // Its handler takes the context this base prepares (the declaration's type requires it) and answers a
    // value the execution path checks against the output schema.
    execute(base.definition.errors, declaration.handler) as OperationHandler<C, I, O, Bound>
  );
}

/**
 * Binds a `defineTool` declaration to the application, under the name its file gives: `summarize-tasks` is
 * the operation `summarizeTasks` and the tool `summarize_tasks`.
 */
export function bindTool<E, C, I extends TSchema, O extends TSchema, X, const F extends string>(
  base: ApplicationBuilder<E, C, Record<never, never>>,
  declaration: ToolDeclaration<I, O, X, C>,
  file: F
) {
  if (!isToolDeclaration(declaration)) {
    throw new TypeError(`Tool ${file}: an MCP tool file's default export must come from defineTool.`);
  }
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(file)) {
    throw new TypeError(`Tool ${file}: name tool files in kebab-case, such as summarize-tasks.ts.`);
  }
  const {
    effect,
    scope,
    title,
    idempotent = effect === 'read',
    openWorld,
    ...options
  }: ToolOptions = declaration.options;
  const name = file.replaceAll('-', '_');
  type Bound = BoundTool<X, F>;
  const definition = {
    ...options,
    title: title ?? humanize(name),
    effect,
    scope: scope ?? `${base.definition.namespace}:${file}:${effect === 'read' ? 'read' : 'write'}`,
    input: declaration.input,
    output: declaration.output,
    mcp: { name, idempotent, ...(openWorld === undefined ? {} : { openWorld }) },
  };
  return base.operation<ToolName<F>, I, O, Bound>(
    // `toolName` derives at runtime the name `ToolName` derives in the type.
    toolName(file) as ToolName<F>,
    // As for a route: the declaration's checked fields and the derived ones.
    definition as unknown as OperationDefinition<I, O, Bound> & KnownOperationFields<Bound>,
    execute(base.definition.errors, declaration.handler) as OperationHandler<C, I, O, Bound>
  );
}
