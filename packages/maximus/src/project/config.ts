/** Runtime-neutral project configuration. Importing it never loads workerd or build tooling. */
import { maximus } from '../builder.ts';
import type { ApplicationBuilder, ApplicationConfiguration } from '../builder.ts';
import type { HttpMiddleware } from '../http.ts';
import type { Invocation, OperationMiddleware, OperationShape, AppManifest } from '../manifest.ts';
import type { WorkerOptions } from '../workers/runtime.ts';

export { createRoute } from './route.ts';
export { bindContext, bindRoute, bindTool, routeName, toolName } from './bind.ts';
export type { RouteName, ToolMcpName, ToolName } from './bind.ts';

/** Configuration owns the shared builder and transport policy, never discovered application modules. */
export interface ProjectConfiguration<E, C> {
  application: ApplicationBuilder<E, C, Record<never, never>>;
  worker: WorkerOptions<E>;
}

/** A simple application configuration needs no hand-written builder or Worker entry. */
export function defineConfig<E>(
  configuration: ApplicationConfiguration<E> & { worker?: WorkerOptions<E> }
): ProjectConfiguration<E, Invocation<E>>;
/** An existing fluent base retains its derived context and middleware. */
export function defineConfig<E, C>(configuration: {
  application: ApplicationBuilder<E, C, Record<never, never>>;
  worker?: WorkerOptions<E>;
}): ProjectConfiguration<E, C>;
export function defineConfig<E, C>(
  configuration:
    | (ApplicationConfiguration<E> & { worker?: WorkerOptions<E> })
    | { application: ApplicationBuilder<E, C, Record<never, never>>; worker?: WorkerOptions<E> }
): ProjectConfiguration<E, C> | ProjectConfiguration<E, Invocation<E>> {
  if ('application' in configuration) {
    if (Object.keys(configuration.application.definition.operations).length) {
      throw new TypeError('Project configuration accepts a base before operations are declared.');
    }
    return { application: configuration.application, worker: configuration.worker ?? {} };
  }
  const { worker = {}, ...application } = configuration;
  return { application: maximus(application), worker };
}

/** Request middleware has no principal; authentication belongs to the native transport continuation. */
export interface RequestMiddlewareModule<E> {
  readonly phase: 'request';
  readonly handle: HttpMiddleware<E>;
}

/** Declare a global HTTP wrapper in middleware/, ordered by filename. */
export function defineMiddleware<E>(handle: HttpMiddleware<E>): RequestMiddlewareModule<E> {
  return { phase: 'request', handle };
}

/** Post-admission middleware runs on HTTP, MCP and RPC and may inspect verified invocation context. */
export interface OperationMiddlewareModule<C> {
  readonly phase: 'operation';
  readonly handle: OperationMiddleware<C>;
}

/** Use this phase for business policy that must apply to every operation transport. */
export function defineOperationMiddleware<C>(handle: OperationMiddleware<C>): OperationMiddlewareModule<C> {
  return { phase: 'operation', handle };
}

/** Legacy bare functions retain their post-admission meaning. */
export type ProjectMiddleware<E, C> =
  | OperationMiddleware<C>
  | OperationMiddlewareModule<C>
  | RequestMiddlewareModule<E>;

type OperationHandle<M> =
  M extends OperationMiddlewareModule<infer C>
    ? OperationMiddleware<C>
    : M extends OperationMiddleware<never>
      ? M
      : never;
type RequestHandle<M> = M extends RequestMiddlewareModule<infer E> ? HttpMiddleware<E> : never;

/** Split phases, retaining every module's context type rather than widening legacy middleware. */
export function collectMiddleware<const Modules extends readonly ProjectMiddleware<never, never>[]>(
  modules: Modules
) {
  const middleware: OperationMiddleware<never>[] = [];
  const requestMiddleware: HttpMiddleware<never>[] = [];
  for (const module of modules) {
    if (typeof module === 'function') {
      middleware.push(module);
    } else if (module.phase === 'operation' && typeof module.handle === 'function') {
      middleware.push(module.handle);
    } else if (module.phase === 'request' && typeof module.handle === 'function') {
      requestMiddleware.push(module.handle);
    } else {
      throw new TypeError('A middleware module must use defineMiddleware or defineOperationMiddleware.');
    }
  }
  // The discriminants above select only these original handles, preserving their union of contexts.
  return {
    middleware: middleware as OperationHandle<Modules[number]>[],
    requestMiddleware: requestMiddleware as RequestHandle<Modules[number]>[],
  };
}

/** Apply discovered policy before route factories capture the base's native execution pipeline. */
export function useProjectMiddleware<E, C>(
  base: ApplicationBuilder<E, C, Record<never, never>>,
  middleware: readonly OperationMiddleware<C>[]
) {
  let application = base;
  for (const handler of middleware) {
    application = application.use(handler);
  }
  return application;
}

/** Typed invocation of a project, available to middleware through a type-only configuration import. */
export type ProjectContext<T> =
  T extends ProjectConfiguration<infer _E, infer C>
    ? C
    : T extends ApplicationBuilder<infer _E, infer C, infer _O>
      ? C
      : never;
/** Bindings inferred from the project's configuration. */
export type ProjectEnv<T> =
  T extends ProjectConfiguration<infer E, infer _C>
    ? E
    : T extends ApplicationBuilder<infer E, infer _C, infer _O>
      ? E
      : never;

/** Refuse a route factory that captured an earlier base and silently omitted discovered policy. */
export function checkProjectPipeline<E, C, BC, O extends Record<string, OperationShape>>(
  base: ApplicationBuilder<E, BC, Record<never, never>>,
  app: AppManifest<E, C, O>
): AppManifest<E, C, O> {
  const expected = base.definition.middleware ?? [];
  for (const [name, operation] of Object.entries(app.operations)) {
    if (expected.some((handler, index) => operation.pipeline?.middleware[index] !== handler)) {
      throw new TypeError(
        `Operation "${name}" omits project middleware. Derive its factory from .maximus/base or .maximus/routes.`
      );
    }
  }
  return app;
}

/** Explicit request-phase spelling; defineMiddleware remains the concise file-convention helper. */
export const defineRequestMiddleware = defineMiddleware;
