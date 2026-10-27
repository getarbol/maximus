/**
 * `@arbol-ai/maximus/config`: what a project's modules declare and what the generated `.maximus/` modules use
 * to bind them to the application. Runtime-neutral: importing it never loads workerd or build tooling.
 */
import type { ApplicationBuilder } from '../builder.ts';
import type { HttpMiddleware } from '../http.ts';
import type { AppManifest, OperationMiddleware, OperationShape } from '../manifest.ts';

export { bindContext, bindRoute, bindTool, routeName, toolName } from './bind.ts';
export type { ToolMcpName, ToolName } from './bind.ts';

/** A `middleware/` module that wraps every HTTP request before token admission: it sees no principal. */
export interface RequestMiddlewareModule<E> {
  readonly phase: 'request';
  readonly handle: HttpMiddleware<E>;
}

/**
 * Declares a `middleware/` module that wraps every HTTP request, in filename order, before the request's
 * token is verified: CORS, security headers, request ids. It cannot authenticate a caller or bypass admission.
 */
export function defineMiddleware<E>(handle: HttpMiddleware<E>): RequestMiddlewareModule<E> {
  return { phase: 'request', handle };
}

/** A `middleware/` module that runs after admission, on every operation over HTTP, MCP and RPC. */
export interface OperationMiddlewareModule<C> {
  readonly phase: 'operation';
  readonly handle: OperationMiddleware<C>;
}

/**
 * Declares a `middleware/` module that runs after the caller is admitted, around every operation over HTTP,
 * MCP and RPC, with the verified invocation: business policy that must hold on every transport.
 */
export function defineOperationMiddleware<C>(handle: OperationMiddleware<C>): OperationMiddlewareModule<C> {
  return { phase: 'operation', handle };
}

/** What a `middleware/` module default-exports. */
export type ProjectMiddleware<E, C> = OperationMiddlewareModule<C> | RequestMiddlewareModule<E>;

/** The operation middleware of a module, with its own context type. */
type OperationHandle<M> = M extends OperationMiddlewareModule<infer C> ? OperationMiddleware<C> : never;
/** The request middleware of a module, with its own bindings type. */
type RequestHandle<M> = M extends RequestMiddlewareModule<infer E> ? HttpMiddleware<E> : never;

/**
 * Splits `middleware/`'s modules by phase, in their order, keeping each module's own context type. A default
 * export that neither helper made is refused.
 */
export function collectMiddleware<const Modules extends readonly ProjectMiddleware<never, never>[]>(
  modules: Modules
) {
  const middleware: OperationMiddleware<never>[] = [];
  const requestMiddleware: HttpMiddleware<never>[] = [];
  for (const module of modules) {
    if (module?.phase === 'operation' && typeof module.handle === 'function') {
      middleware.push(module.handle);
    } else if (module?.phase === 'request' && typeof module.handle === 'function') {
      requestMiddleware.push(module.handle);
    } else {
      throw new TypeError(
        'A middleware module must default-export defineMiddleware or defineOperationMiddleware.'
      );
    }
  }
  // The discriminants above select only these original handles, preserving their union of contexts.
  return {
    middleware: middleware as OperationHandle<Modules[number]>[],
    requestMiddleware: requestMiddleware as RequestHandle<Modules[number]>[],
  };
}

/** Applies the project's operation middleware to its base, before any route binds to it. */
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

/**
 * Refuses an application whose operations do not all run the project's middleware, as a route bound to an
 * earlier base would: its policy would silently be skipped.
 */
export function checkProjectPipeline<E, C, BC, O extends Record<string, OperationShape>>(
  base: ApplicationBuilder<E, BC, Record<never, never>>,
  app: AppManifest<E, C, O>
): AppManifest<E, C, O> {
  const expected = base.definition.middleware ?? [];
  for (const [name, operation] of Object.entries(app.operations)) {
    if (expected.some((handler, index) => operation.pipeline?.middleware[index] !== handler)) {
      throw new TypeError(
        `Operation "${name}" omits project middleware. Bind it to the base in .maximus/base.ts.`
      );
    }
  }
  return app;
}
