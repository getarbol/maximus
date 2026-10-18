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

/** Explicit assets policy. Unknown paths never receive the SPA shell. */
export interface WorkerAssetsOptions<E> {
  /** Environment binding whose fetch method serves the uploaded build files. */
  binding: AssetBindingName<E>;
  /** Known SPA routes. Stateless expressions may admit product-owned detail routes. */
  pages?: {
    paths: readonly string[];
    patterns?: readonly RegExp[];
    /** Build shell fetched for admitted pages; defaults to /index.html. */
    shell?: string;
  };
  /** Named build files that must revalidate, such as manifests and service workers. */
  files?: readonly string[];
  /** Slash-delimited namespaces containing content-hashed, immutable build files. */
  immutablePrefixes?: readonly string[];
  /** Product browser policy, including CSP. Native content type and cache policy remain authoritative. */
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
/** The path, refused at construction when it is not an absolute asset path or has dot segments. */
function requireAssetPath(path: string): string {
  if (!ASSET_PATH.test(path) || path.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new TypeError(`Asset path must be absolute without query, fragments or dot segments: ${path}`);
  }
  return path;
}
/** Whether a binding can fetch assets. */
function isAssetBinding(value: unknown): value is AssetBinding {
  return typeof value === 'object' && value !== null && 'fetch' in value && typeof value.fetch === 'function';
}
/** Compile the explicit build policy once; core HTTP retains ownership of API and transport misses. */
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
    const isImmutable = immutablePrefixes.some(
      (prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)
    );
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
