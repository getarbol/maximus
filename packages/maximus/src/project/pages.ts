/**
 * Where a project's pages answer: fixed paths outside the API and protocol namespaces. The Worker checks its
 * pages as it starts, and `maximus prepare` checks `pages/` with the same rule before any Worker does.
 */
import type { HttpTransport } from '../http.ts';
import { nativePaths, ownsPrefix, VERSIONED_PATH } from '../internal/http-layout.ts';
import type { TokenPolicy } from '../tokens.ts';
import type { WorkerOptions } from '../workers/runtime.ts';

/** What the Worker answers besides its pages, as its options state it; a transport by its path alone. */
interface PageNeighbors<E> extends Pick<WorkerOptions<E>, 'http' | 'routes'> {
  transports?: readonly Pick<HttpTransport, 'path'>[];
}

/**
 * Refuses a malformed page path, and one the Worker answers otherwise: the API's base path and below it, its
 * discovery and liveness paths, versioned operation paths, `/.well-known`, a plain route, a mount or a
 * transport.
 */
export function checkPagePaths<E>(
  paths: Iterable<string>,
  tokens: TokenPolicy<E>,
  neighbors: PageNeighbors<E>
): void {
  const native = nativePaths(tokens, neighbors.http ?? {});
  for (const path of paths) {
    if (
      !/^\/(?:[a-zA-Z0-9._~-]+(?:\/[a-zA-Z0-9._~-]+)*)?$/.test(path) ||
      path.split('/').some((segment) => segment === '.' || segment === '..') ||
      native.reserved.has(path) ||
      (native.base && ownsPrefix(native.base, path)) ||
      VERSIONED_PATH.test(path) ||
      ownsPrefix('/.well-known', path) ||
      Object.hasOwn(neighbors.routes ?? {}, path) ||
      Object.keys(neighbors.http?.mounts ?? {}).some((prefix) => ownsPrefix(prefix, path)) ||
      neighbors.transports?.some((transport) => ownsPrefix(transport.path, path))
    ) {
      throw new TypeError(`Page path is reserved or malformed: ${path}. Move the API with http.basePath.`);
    }
  }
}
