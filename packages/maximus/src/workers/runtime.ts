/**
 * `@arbol-ai/maximus/workers`: turns an application into a Cloudflare Worker: its fetch handler, its RPC
 * entrypoint, and the instrumentation of the Worker's other classes.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { DurableObject } from 'cloudflare:workers';

import { executeOperation } from '../execution.ts';
import { standardErrors, createHttpHandler, err, PrincipalSchema, parseInput } from '../index.ts';
import type { Static, Failure, Result, Principal, HttpRoute } from '../index.ts';
import type { HttpOptions, AppManifest, OperationShape } from '../internals.ts';
import { recordExecution, reportUnexpected, telemetryEnabled, withTelemetry } from '../telemetry.ts';
import { createAssetHandler } from './assets.ts';
import type { WorkerAssetsOptions } from './assets.ts';
import { instrumentDurableObject, instrumentService } from './internal/instrumentation.ts';
import { annotateInvocation } from './internal/worker-tracing.ts';

export type { WorkerAssetsOptions } from './assets.ts';

/**
 * The RPC methods of a Worker's entrypoint: one per operation that declares `rpc`, taking the caller's
 * principal and the input and answering a Result.
 */
export type RpcMethods<Ops extends Record<string, OperationShape>> = {
  [K in keyof Ops as Ops[K] extends { rpc: true | { callers: readonly string[] } } ? K : never]: (
    principal: Principal,
    input: Static<Ops[K]['input']>
  ) => Promise<Result<Static<Ops[K]['output']>, Failure>>;
};
/**
 * What `createWorker` returns: the default export's handler, the named entrypoint for Worker RPC, and
 * wrappers that run your own entrypoints and Durable Objects inside the application's diagnostics.
 */
export interface WorkerRuntime<E, O extends Record<string, OperationShape>> {
  /** The Worker's default export: `fetch` for HTTP, plus the other `handlers` given to `createWorker`. */
  handler: ExportedHandler<E>;
  /**
   * A `WorkerEntrypoint` class with one method per operation that declares `rpc`, each taking the caller's
   * principal and the input and answering a Result; export it by name for Service Bindings to call.
   */
  entrypoint: new (ctx: ExecutionContext, env: E) => WorkerEntrypoint<E> & RpcMethods<O>;
  /**
   * Wraps your own `WorkerEntrypoint` class so its methods run inside the application's diagnostics; it keeps
   * its methods and type.
   */
  service: <D extends new (ctx: ExecutionContext, env: E) => WorkerEntrypoint<E>>(implementation: D) => D;
  /**
   * Wraps a Durable Object class so its methods run inside the application's diagnostics; it keeps its
   * methods and type.
   */
  durableObject: <T extends DurableObject<E>, D extends new (state: DurableObject['ctx'], env: E) => T>(
    implementation: D
  ) => D;
}
/** A Worker event handler besides fetch: the event, then the bindings and the execution context. */
type WorkerEventHandler<E> = (
  this: ExportedHandler<E>,
  event: unknown,
  env: E,
  context: ExecutionContext
) => unknown;

/**
 * What `createWorker` takes besides the application: the Worker's other handlers, its transports, the HTTP
 * handler's options, its static assets and its plain routes.
 */
export interface WorkerOptions<E> {
  /**
   * The Worker's other handlers (`scheduled`, `queue`, …), merged into the default export. Each runs inside
   * the application's diagnostics: an error it throws is reported by its safe description, then thrown on.
   */
  handlers?: Omit<ExportedHandler<E>, 'fetch'>;
  /** Protocol transports served beside the operations, such as `mcp()`. */
  transports?: HttpOptions<E>['transports'];
  /**
   * The HTTP handler's other options: origins, middleware, `before`, `basePath`, `healthPath`, mounts,
   * `fallback`, `aroundOperation` and the test `verify`.
   */
  http?: Omit<HttpOptions<E>, 'transports' | 'routes' | 'annotate'>;
  /**
   * A web app's build, served from a static-assets binding as the HTTP fallback; it cannot be combined with
   * `http.fallback`.
   */
  assets?: WorkerAssetsOptions<E>;
  /**
   * Plain routes outside token admission (provider webhooks, signed links,
   * OAuth callbacks), by exact path. Each handler verifies its own signature
   * or token before reading the request. They run inside the same handler,
   * so diagnostics cover them too.
   */
  routes?: Readonly<Record<string, HttpRoute<E>>>;
}
/**
 * Turns an application into a Cloudflare Worker: `handler` (export it as default) serves HTTP and the other
 * handlers you pass; `entrypoint` (export it by name) serves every operation that declares `rpc` to the
 * Workers whose Service Binding names an allowed `caller`. An RPC call whose binding's props are anything but
 * `{ caller }` with an allowed caller, or whose principal does not match `PrincipalSchema`, answers
 * `UNAUTHORIZED`; an admitted one runs through the shared execution path without `authority`.
 */
export function createWorker<E, C, O extends Record<string, OperationShape>>(
  application: AppManifest<E, C, O>,
  options: WorkerOptions<E> = {}
): WorkerRuntime<E, O> {
  if (options.assets && options.http?.fallback) {
    throw new TypeError('Worker assets and an HTTP fallback cannot both own unmatched paths.');
  }
  const assets = options.assets ? createAssetHandler(options.assets) : undefined;
  const manifest = application;
  const fetch = createHttpHandler(manifest, {
    ...options.http,
    fallback: assets ?? options.http?.fallback,
    transports: options.transports,
    routes: options.routes,
    annotate: (operation, id) => annotateInvocation(manifest.name, operation, id),
  });
  class Entrypoint extends WorkerEntrypoint<E> {}
  for (const [name, op] of Object.entries(manifest.operations)) {
    if (!op.rpc) {
      continue;
    }
    const callers = op.rpc === true ? manifest.rpc.callers : op.rpc.callers;
    Object.defineProperty(Entrypoint.prototype, name, {
      configurable: true,
      async value(this: Entrypoint, principal: Principal, input: unknown) {
        const props = this.ctx.props as { caller?: unknown };
        if (
          !props ||
          Object.keys(props).length !== 1 ||
          typeof props.caller !== 'string' ||
          !callers.includes(props.caller)
        ) {
          return err(standardErrors.unauthorized.create());
        }
        const parsed = parseInput(PrincipalSchema, principal);
        if (!parsed.ok) {
          return err(standardErrors.unauthorized.create());
        }
        if (telemetryEnabled(manifest.telemetry, this.env)) {
          annotateInvocation(manifest.name, name, parsed.value.requestId);
        }
        const started = performance.now();
        const result = await withTelemetry(manifest.telemetry, this.env, () =>
          executeOperation(manifest, op, this.env, parsed.value, input, undefined, this.ctx)
        );
        recordExecution(manifest, this.env, this.ctx, {
          principal: parsed.value,
          operation: name,
          surface: 'rpc',
          started,
          result,
        });
        return result;
      },
    });
  }
  const service = <D extends new (ctx: ExecutionContext, env: E) => WorkerEntrypoint<E>>(
    implementation: D
  ): D => instrumentService(implementation, manifest.telemetry);
  const entrypoint = service(Entrypoint) as typeof Entrypoint & {
    new (...args: ConstructorParameters<typeof Entrypoint>): Entrypoint & RpcMethods<O>;
  };
  // Every other handler (scheduled, queue, email, tail, …) runs inside the application's diagnostics, as
  // fetch does: a failure is reported by its safe description, then thrown on for the platform to retry or
  // record, as it would without Maximus.
  const handler: Record<string, unknown> = { fetch };
  for (const [event, implementation] of Object.entries(options.handlers ?? {})) {
    if (typeof implementation !== 'function') {
      continue;
    }
    const run = implementation as WorkerEventHandler<E>;
    handler[event] = function handle(
      this: ExportedHandler<E>,
      payload: unknown,
      env: E,
      context: ExecutionContext
    ) {
      return withTelemetry(manifest.telemetry, env, async () => {
        try {
          return await run.call(this, payload, env, context);
        } catch (error) {
          reportUnexpected(error, event);
          throw error;
        }
      });
    };
  }

  return {
    handler: handler as ExportedHandler<E>,
    entrypoint,
    service,
    durableObject(implementation) {
      return instrumentDurableObject(implementation, manifest.telemetry);
    },
  };
}
export { credentials } from './credentials.ts';
