/**
 * Serves a web app's build through a Workers static-assets binding: known pages get the app shell, named
 * files revalidate, content-hashed files are immutable, and every other path is refused.
 */
import { standardErrors } from '../index.ts';
import type { HttpRoute } from '../index.ts';

/** A Workers static-assets binding; product stores and secrets never satisfy this capability. */
interface AssetBinding {
  /** Answers a request with the uploaded build file at its URL path. */
  fetch: (request: Request) => Promise<Response>;
}
/** The names of the env bindings that are asset bindings. */
type AssetBindingName<E> = {
  [K in keyof E]-?: E[K] extends AssetBinding ? K : never;
}[keyof E] &
  string;

/**
 * Which paths of a web app's build the Worker serves, and how: a page answers the app's shell, a listed file
 * revalidates on every use, a file under an immutable prefix is cached for a year, and any other path answers
 * `NOT_FOUND`, never the shell (under `development`, the dev server answers it). A method other than GET or
 * HEAD answers `HTTP_METHOD_NOT_ALLOWED`.
 */
export interface WorkerAssetsOptions<E> {
  /** The name of the static-assets binding that serves the build's files. */
  binding: AssetBindingName<E>;
  /** The app's pages, which answer its shell with `cache-control: no-store`. */
  pages?: {
    /** The pages' exact paths, such as `/` and `/settings`. */
    paths: readonly string[];
    /**
     * Patterns for pages whose paths carry a parameter, such as `/^\/notes\/[\w-]+$/`: regular expressions
     * without the global or sticky flag.
     */
    patterns?: readonly RegExp[];
    /** The build file a page answers with; `/index.html` by default. */
    shell?: string;
  };
  /**
   * Build files served by exact path that clients revalidate on every use (`cache-control: no-cache`), such
   * as a manifest or a service worker.
   */
  files?: readonly string[];
  /**
   * Path prefixes whose files are content-hashed, served with `cache-control: public, max-age=31536000,
   * immutable`; a prefix may not be `/`.
   */
  immutablePrefixes?: readonly string[];
  /**
   * Response headers for every page and file, such as a Content Security Policy, or a function of the request
   * and env that answers them. They never set `content-type` or `cache-control`, which the build file and
   * the path decide.
   */
  headers?: HeadersInit | ((request: Request, env: E) => HeadersInit);
  /**
   * Development under Vite (the Cloudflare Vite plugin), whose dev server stands behind the binding:
   * a GET the Worker does not serve as a page, file or immutable asset (Vite's client, modules and
   * sources) is forwarded to it as it came. Pass `import.meta.env.DEV`, which a production build sets to
   * false: a deployed Worker must never forward unknown paths.
   */
  development?: boolean;
}

/** An absolute asset path of unreserved characters, without a query or a fragment. */
const ASSET_PATH = /^\/(?:[a-zA-Z0-9._~-]+(?:\/[a-zA-Z0-9._~-]+)*)?$/;
/** Whether a path is an absolute asset path: unreserved characters, nothing encoded, no dot segments. */
function isAssetPath(path: string): boolean {
  return ASSET_PATH.test(path) && !path.split('/').some((segment) => segment === '.' || segment === '..');
}
/** The path, refused at construction when it is not an absolute asset path or has dot segments. */
function requireAssetPath(path: string): string {
  if (!isAssetPath(path)) {
    throw new TypeError(`Asset path must be absolute without query, fragments or dot segments: ${path}`);
  }
  return path;
}
/** Whether a binding can fetch assets. */
function isAssetBinding(value: unknown): value is AssetBinding {
  return typeof value === 'object' && value !== null && 'fetch' in value && typeof value.fetch === 'function';
}
/**
 * The route that serves a web app's build by `options`, which `createWorker` installs as the HTTP fallback,
 * so it answers only paths no operation, transport or other route claims. Construction throws a TypeError
 * for a path that is not an absolute asset path, a global or sticky pattern, or an immutable prefix of `/`.
 */
export function createAssetHandler<E>(options: WorkerAssetsOptions<E>): HttpRoute<E> {
  const bindingName = options.binding;
  const pages = new Set(options.pages?.paths.map(requireAssetPath));
  const files = new Set(options.files?.map(requireAssetPath));
  const shell = requireAssetPath(options.pages?.shell ?? '/index.html');
  const patterns =
    options.pages?.patterns?.map((pattern) => {
      if (!(pattern instanceof RegExp) || pattern.global || pattern.sticky) {
        throw new TypeError(
          'Asset page patterns must be stateless regular expressions without global or sticky flags.'
        );
      }
      return new RegExp(pattern.source, pattern.flags);
    }) ?? [];
  const immutablePrefixes =
    options.immutablePrefixes?.map((path) => {
      const prefix = requireAssetPath(path.endsWith('/') ? path.slice(0, -1) : path);
      if (prefix === '/') {
        throw new TypeError('An immutable assets prefix must not claim the entire origin.');
      }
      return prefix;
    }) ?? [];
  const configuredHeaders =
    typeof options.headers === 'function' ? options.headers : new Headers(options.headers);
  return async (request, env, context) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return context.fail(standardErrors.methodNotAllowed.create(), { Allow: 'GET, HEAD' });
    }
    const url = new URL(request.url);
    const isPage = pages.has(url.pathname) || patterns.some((pattern) => pattern.test(url.pathname));
    const isFile = files.has(url.pathname);
    // A prefix matches only a plain path: an encoded slash or dot segment never reaches the binding as
    // an immutable file.
    const isImmutable =
      isAssetPath(url.pathname) &&
      immutablePrefixes.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
    const binding = env[bindingName];
    if (!(isPage || isFile || isImmutable)) {
      if (options.development && isAssetBinding(binding)) {
        return binding.fetch(request);
      }
      return context.fail(standardErrors.notFound.create());
    }
    if (!isAssetBinding(binding)) {
      throw new TypeError('The configured Worker assets binding does not implement fetch.');
    }
    // Build retrieval receives only the selected path and method, never credentials, query or product headers.
    const assetUrl = new URL(isPage ? shell : url.pathname, url.origin);
    const asset = await binding.fetch(new Request(assetUrl, { method: request.method }));
    const headers = new Headers(asset.headers);
    const policy =
      typeof configuredHeaders === 'function'
        ? new Headers(configuredHeaders(request, env))
        : configuredHeaders;
    for (const [name, value] of policy) {
      if (name !== 'content-type' && name !== 'cache-control') {
        headers.set(name, value);
      }
    }
    headers.set('x-content-type-options', 'nosniff');
    let cache = 'public, max-age=31536000, immutable';
    if (isPage || asset.status !== 200) {
      cache = 'no-store';
    } else if (isFile) {
      cache = 'no-cache';
    }
    headers.set('cache-control', cache);
    if (request.method === 'HEAD' && asset.body) {
      await asset.body.cancel();
    }
    return new Response(request.method === 'HEAD' ? null : asset.body, {
      status: asset.status,
      statusText: asset.statusText,
      headers,
    });
  };
}
