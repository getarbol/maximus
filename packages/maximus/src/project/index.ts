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

/** The methods a page may answer; one that answers `GET` also answers `HEAD`. */
export type PageMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * A page: a native response handler at a fixed path outside the API, such as a landing page or a provider's
 * webhook. A function answers `GET`; a record answers each method it names, `{ POST: receive }`.
 */
export type ProjectPage<E> = HttpRoute<E> | Readonly<Partial<Record<PageMethod, HttpRoute<E>>>>;

/** The modules a project's Worker composes: its pages and its event handlers. */
export interface ProjectModules<E> extends ProjectEvents<E> {
  /**
   * The pages, keyed by their path: fixed paths the API, discovery and the Worker's other routes leave free.
   * Rendering libraries stay in the application.
   */
  pages?: Readonly<Record<string, ProjectPage<E>>>;
}

/** The methods a page record may name. */
const PAGE_METHODS: ReadonlySet<string> = new Set<PageMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
/** The order an `allow` header lists a page's methods in: `HEAD` beside the `GET` that answers it. */
const ALLOW_ORDER = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** A page as the Worker answers it. */
interface PageRoutes<E> {
  /** The handler for each method the page declares, keyed by the method. */
  methods: ReadonlyMap<string, HttpRoute<E>>;
  /** The `allow` header a refused method is answered with: the declared methods, and `HEAD` with `GET`. */
  allow: string;
}

/**
 * Each method a page answers, with its handler. Refuses a method other than `GET`, `POST`, `PUT`, `PATCH`
 * and `DELETE`, a handler that is not a function, and a record that names no method.
 */
function pageRoutes<E>(path: string, page: ProjectPage<E>): PageRoutes<E> {
  const entries: [string, HttpRoute<E> | undefined][] =
    typeof page === 'function' ? [['GET', page]] : Object.entries(page);
  const methods = new Map<string, HttpRoute<E>>();
  for (const [method, route] of entries) {
    if (!PAGE_METHODS.has(method) || typeof route !== 'function') {
      throw new TypeError(
        `Page ${path} must map GET, POST, PUT, PATCH or DELETE to a handler function; it maps ${method}.`
      );
    }
    methods.set(method, route);
  }
  if (methods.size === 0) {
    throw new TypeError(`Page ${path} must answer at least one method.`);
  }
  const allow = ALLOW_ORDER.filter((method) => methods.has(method === 'HEAD' ? 'GET' : method)).join(', ');
  return { methods, allow };
}

/**
 * Compose discovered modules through the existing runtime. Operations keep its single authorization,
 * schema and diagnostic pipeline; pages only answer paths outside the API and protocol namespaces, each the
 * methods it declares, and `405` with an `allow` header for any other.
 */
export function createProjectWorker<E, C, O extends Record<string, OperationShape>>(
  app: AppManifest<E, C, O>,
  modules: ProjectModules<E>,
  options: WorkerOptions<E> = {}
): WorkerRuntime<E, O> {
  if (options.assets && options.http?.fallback) {
    throw new TypeError('Worker assets and an HTTP fallback cannot both own unmatched paths.');
  }
  const pages = new Map(
    Object.entries(modules.pages ?? {}).map(([path, page]) => [path, pageRoutes(path, page)] as const)
  );
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
          const route = page.methods.get(request.method === 'HEAD' ? 'GET' : request.method);
          if (!route) {
            return context.fail(standardErrors.methodNotAllowed.create(), { allow: page.allow });
          }
          const response = await route(request, env, context);
          return request.method === 'HEAD' ? new Response(null, response) : response;
        }
        return fallback
          ? await fallback(request, env, context)
          : context.fail(standardErrors.notFound.create());
      },
    },
  });
}
