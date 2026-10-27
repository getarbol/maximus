/** Optional Workers composition for projects whose modules are discovered by `maximus prepare`. */
import { standardErrors } from '../errors.ts';
import type { HttpRoute } from '../http.ts';
import type { AppManifest, OperationShape } from '../manifest.ts';
import { createAssetHandler } from '../workers/assets.ts';
import { createWorker } from '../workers/runtime.ts';
import type { WorkerOptions, WorkerRuntime } from '../workers/runtime.ts';
import { projectHandlers } from './handlers.ts';
import type { ProjectEvents } from './handlers.ts';
import { checkPagePaths } from './pages.ts';

export type { ProjectCron, ProjectEvents } from './handlers.ts';

/** Pages are native response handlers; rendering libraries stay in the application. */
export interface ProjectModules<E> extends ProjectEvents<E> {
  pages?: Readonly<Record<string, HttpRoute<E>>>;
}

/**
 * Compose discovered modules through the existing runtime. Operations keep its single authorization,
 * schema and diagnostic pipeline; pages only answer paths outside the API and protocol namespaces.
 */
export function createProjectWorker<E, C, O extends Record<string, OperationShape>>(
  app: AppManifest<E, C, O>,
  modules: ProjectModules<E>,
  options: WorkerOptions<E> = {}
): WorkerRuntime<E, O> {
  if (options.assets && options.http?.fallback) {
    throw new TypeError('Worker assets and an HTTP fallback cannot both own unmatched paths.');
  }
  const pages = new Map(Object.entries(modules.pages ?? {}));
  checkPagePaths(pages.keys(), app.tokens, options);
  const fallback = options.assets ? createAssetHandler(options.assets) : options.http?.fallback;
  return createWorker(app, {
    ...options,
    assets: undefined,
    handlers: projectHandlers(modules, options.handlers),
    http: {
      ...options.http,
      async fallback(request, env, context) {
        const page = pages.get(new URL(request.url).pathname);
        if (page) {
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            return context.fail(standardErrors.methodNotAllowed.create(), { allow: 'GET, HEAD' });
          }
          const response = await page(request, env, context);
          return request.method === 'HEAD' ? new Response(null, response) : response;
        }
        return fallback
          ? await fallback(request, env, context)
          : context.fail(standardErrors.notFound.create());
      },
    },
  });
}
