/**
 * Where everything an HTTP handler serves lives, checked once at construction: the application's own
 * paths below its base path, its transports, its plain routes and its mounts. No two of them may
 * claim the same path, and none may claim an operation route's.
 */
import type { HttpOptions, HttpRoute, HttpTransport } from '../http.ts';
import type { OAuthResource } from '../oauth.ts';
import { usesOwnBearer } from '../tokens.ts';
import type { TokenPolicy } from '../tokens.ts';

/** The paths an application answers itself, below its base path: discovery and liveness. */
const NATIVE_PATHS = [
  '/',
  '/health',
  '/openapi.json',
  '/openapi.yaml',
  '/openapi.yml',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
];
/** An absolute path of slash-separated unreserved characters. */
const PLAIN_ROUTE_PATH = /^\/[a-zA-Z0-9._~-]+(?:\/[a-zA-Z0-9._~-]+)*$/;
/** `/v1`, `/v2/…`: the namespace of operation routes, which nothing else may claim. */
export const VERSIONED_PATH = /^\/v[1-9][0-9]*(?:\/|$)/;

/** An absolute path of unreserved characters, without a trailing slash or dot segments. */
function validPath(path: string): boolean {
  return (
    PLAIN_ROUTE_PATH.test(path) && !path.split('/').some((segment) => segment === '.' || segment === '..')
  );
}

/** Whether `prefix` owns `path`: the prefix itself, or any slash-delimited descendant. */
export function ownsPrefix(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** The application's own paths: its base path, its discovery documents and its liveness check. */
export interface NativePaths<E> {
  /** `''` when the application is mounted at the root. */
  readonly base: string;
  /** A native path (`/openapi.json`) as it is served, below the base path. */
  mount: (path: string) => string;
  /** A served path as the native path it is, or null outside the base path. */
  local: (path: string) => string | null;
  /** Every path only the framework answers. */
  readonly reserved: Set<string>;
  /** The absolute liveness path: `healthPath` when set, else `/health` below the base path. */
  readonly health: string;
  /** Distinct RFC 9728 discovery documents, by absolute path. */
  readonly resources: ReadonlyMap<string, OAuthResource<E>>;
}

/**
 * Checks where the application's own paths live: its base path, its liveness path and its OAuth resources.
 */
export function nativePaths<E>(tokens: TokenPolicy<E>, hooks: HttpOptions<E>): NativePaths<E> {
  const base = hooks.basePath === '/' ? '' : (hooks.basePath ?? '');
  if (base && !validPath(base)) {
    throw new TypeError('HTTP basePath must be an absolute path without a trailing slash or dot segments.');
  }
  /** A native path as served below the base path. */
  const mount = (path: string) => (base ? `${base}${path === '/' ? '' : path}` : path);
  /** A served path as the native path it is, or null outside the base path. */
  const local = (path: string): string | null => {
    if (base === '') {
      return path;
    }
    if (path === base) {
      return '/';
    }
    return path.startsWith(`${base}/`) ? path.slice(base.length) : null;
  };
  const reserved = new Set(NATIVE_PATHS.map(mount));
  const health = hooks.healthPath ?? mount('/health');
  if (
    !validPath(health) ||
    (reserved.has(health) && health !== mount('/health')) ||
    VERSIONED_PATH.test(local(health) ?? '')
  ) {
    throw new TypeError('HTTP healthPath must be an unreserved absolute path.');
  }
  reserved.add(health);
  const resources = new Map(Object.entries(tokens.resources ?? {}));
  for (const path of resources.keys()) {
    if (!validPath(path) || !ownsPrefix('/.well-known/oauth-protected-resource', path) || path === health) {
      throw new TypeError('OAuth resources require distinct absolute protected-resource discovery paths.');
    }
    reserved.add(path);
  }
  return { base, mount, local, reserved, health, resources };
}

/** The transports by path, and the one MCP transport among them, if any. */
export interface Transports {
  /** Each transport by the exact path it answers. */
  readonly byPath: ReadonlyMap<string, HttpTransport>;
  /** The MCP transport, identified by its `protocol` or its `/mcp` path; undefined when none is mounted. */
  readonly mcp: HttpTransport | undefined;
}

/**
 * Checks the transports: one per path, at most one MCP transport, and one whenever the application configures
 * MCP.
 */
export function httpTransports(transports: readonly HttpTransport[] = [], mcpConfigured = false): Transports {
  const byPath = new Map(transports.map((transport) => [transport.path, transport]));
  const mcpTransports = [...byPath.values()].filter(
    (transport) => transport.protocol === 'mcp' || transport.path === '/mcp'
  );
  if (mcpTransports.length > 1) {
    throw new TypeError('An HTTP handler may mount only one MCP transport.');
  }
  const [mcp] = mcpTransports;
  if (mcpConfigured && !mcp) {
    throw new TypeError('MCP configuration requires the optional MCP transport.');
  }
  if (byPath.size !== transports.length) {
    throw new TypeError('Duplicate transport path.');
  }
  return { byPath, mcp };
}

/**
 * Whether the application issues its own bearer tokens, refusing a token scheme the handler could
 * never serve: own bearer tokens publish no OAuth discovery, need a resolver and cannot serve MCP.
 */
export function servesOwnBearer<E>(tokens: TokenPolicy<E>, mcp: HttpTransport | undefined): boolean {
  const ownBearer = usesOwnBearer(tokens);
  if (ownBearer && tokens.resources !== undefined) {
    throw new TypeError('A bearer token scheme cannot publish OAuth resource discovery.');
  }
  if ((ownBearer || tokens.scheme?.type === 'oauth+bearer') && !tokens.resolve) {
    throw new TypeError('An application bearer token scheme requires tokens.resolve to verify the token.');
  }
  if (ownBearer && mcp) {
    throw new TypeError('The MCP transport needs OAuth discovery; it cannot serve a bearer token scheme.');
  }
  return ownBearer;
}

/** Plain routes by exact path, and the mounted protocol that owns a path. */
export interface Composition<E> {
  /** The plain routes, by the exact path each answers. */
  readonly routes: ReadonlyMap<string, HttpRoute<E>>;
  /** The mount that owns `path`: the longest mounted prefix of it. */
  mounted: (path: string) => HttpRoute<E> | undefined;
}

/**
 * Checks that every transport, plain route and mount path is well formed and claims nothing the
 * application, an operation route or another of them already owns.
 */
export function composition<E>(
  paths: NativePaths<E>,
  operations: { ownsPath: (path: string) => boolean },
  transports: Transports,
  hooks: Pick<HttpOptions<E>, 'routes' | 'mounts'>
): Composition<E> {
  const transportPaths = [...transports.byPath.keys()];
  for (const path of transportPaths) {
    if (
      (!(path === '/' && transports.mcp?.path === '/') && !validPath(path)) ||
      paths.reserved.has(path) ||
      VERSIONED_PATH.test(paths.local(path) ?? '') ||
      operations.ownsPath(paths.local(path) ?? '') ||
      transportPaths.some((other) => other !== path && (ownsPrefix(other, path) || ownsPrefix(path, other)))
    ) {
      throw new TypeError(`Transport path is reserved: ${path}`);
    }
  }
  const routes = new Map(Object.entries(hooks.routes ?? {}));
  for (const path of routes.keys()) {
    // A transport answers exactly its own path, so an explicit route may sit beneath it.
    if (
      !validPath(path) ||
      VERSIONED_PATH.test(paths.local(path) ?? '') ||
      paths.reserved.has(path) ||
      operations.ownsPath(paths.local(path) ?? '') ||
      transports.byPath.has(path)
    ) {
      throw new TypeError(`Route path is reserved or malformed: ${path}`);
    }
  }
  const mounts = new Map(Object.entries(hooks.mounts ?? {}));
  for (const prefix of mounts.keys()) {
    const local = paths.local(prefix);
    if (
      !validPath(prefix) ||
      VERSIONED_PATH.test(local ?? '') ||
      [...paths.reserved].some((path) => ownsPrefix(prefix, path)) ||
      [...transportPaths, ...routes.keys()].some(
        (path) => ownsPrefix(prefix, path) || ownsPrefix(path, prefix)
      ) ||
      operations.ownsPath(local ?? '')
    ) {
      throw new TypeError(`Mount path is reserved or malformed: ${prefix}`);
    }
  }
  return {
    routes,
    mounted(path) {
      let route: HttpRoute<E> | undefined;
      let prefix = '';
      for (const segment of path.slice(1).split('/')) {
        prefix += `/${segment}`;
        route = mounts.get(prefix) ?? route;
      }
      return route;
    },
  };
}
