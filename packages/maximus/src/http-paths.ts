/**
 * `@arbol-ai/maximus/http-paths`: versioned route templates, path parameter decoding, and the router that
 * matches a request to exactly one operation, on rou3's route tree.
 */
import { addRoute, createRouter, findRoute, routesOverlap } from 'rou3';

/** A fixed path segment of a route template. */
const STATIC_SEGMENT = /^[a-zA-Z0-9_-]+$/;
/** A parameter segment of a route template, `{name}`, occupying the whole segment. */
const PARAMETER_SEGMENT = /^\{([a-zA-Z][a-zA-Z0-9_]*)\}$/;
/** Parameter names that would reach an object's prototype. */
const UNSAFE_PARAMETERS = new Set(['constructor', 'prototype', '__proto__']);
/** Headers that carry authority or framing: never an operation's input metadata. */
const RESERVED_HEADERS = new Set(['authorization', 'cookie', 'host', 'content-length', 'content-encoding']);

/** Whether a byte operation may read one of its input fields from this header. */
export function isInputHeaderName(header: string): boolean {
  return /^[A-Za-z0-9-]+$/u.test(header) && !RESERVED_HEADERS.has(header.toLowerCase());
}

/**
 * The parameter names of a declared route template, in order. A template is versioned (`/v1/…`) with at least
 * one segment after the version, each fixed or a complete `{parameter}` with a unique, safe name; anything
 * else throws a TypeError. It reads declared templates, never a request's path.
 */
export function operationPathParameters(path: string): string[] {
  const segments = path.split('/');
  if (segments[0] !== '' || !/^v[1-9][0-9]*$/.test(segments[1] ?? '') || segments.length < 3) {
    throw new TypeError(`Operations require a versioned path, such as /v1/tasks: ${path}`);
  }
  const parameters: string[] = [];
  for (const segment of segments.slice(2)) {
    const parameter = PARAMETER_SEGMENT.exec(segment)?.[1];
    if (parameter) {
      if (UNSAFE_PARAMETERS.has(parameter) || parameters.includes(parameter)) {
        throw new TypeError(`Path parameter names must be unique and safe: ${path}`);
      }
      parameters.push(parameter);
    } else if (!STATIC_SEGMENT.test(segment)) {
      throw new TypeError(
        `Use fixed routes or complete {parameter} segments; empty and malformed segments are forbidden: ${path}`
      );
    }
  }
  return parameters;
}

/**
 * One path segment, percent-decoded, or null when it does not decode or decodes to a value
 * `isPathParameterValue` refuses, so decoding cannot change which route a path reaches.
 */
export function decodePathParameter(segment: string): string | null {
  try {
    const value = decodeURIComponent(segment);
    return isPathParameterValue(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Whether a value can be a path parameter: a nonempty string other than `.` and `..`, without a slash, a
 * backslash, a control character or a lone surrogate, so it stays one segment when encoded.
 */
export function isPathParameterValue(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    /[\\/]/.test(value)
  ) {
    return false;
  }
  for (const character of value) {
    // A lone surrogate has no UTF-8 form, so no URL can carry it.
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127 || (code >= 0xd8_00 && code <= 0xdf_ff)) {
      return false;
    }
  }
  return true;
}

/**
 * What the router reads of a definition: its method and path template. Its other fields come back unchanged
 * in a match; checking a request's input is not the router's work.
 */
export interface HttpRouteDefinition {
  /**
   * The method and versioned path template to route, such as `GET /v1/notes/{noteId}`; a definition without
   * one is not routed.
   */
  http?: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string };
}
/** The methods an operation route may use. */
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** A route and where its parameters sit in the path. */
interface Route<D> {
  /** The definition the route serves, handed back unchanged when it matches. */
  definition: D;
  /** Each path parameter's name and the zero-based index of its segment, the version segment being 0. */
  parameters: readonly { name: string; position: number }[];
}
/** A route as a refusal names it: its method and path template, `GET /v1/notes/{noteId}`. */
function routeName(route: Route<HttpRouteDefinition>): string {
  return `${route.definition.http?.method} ${route.definition.http?.path}`;
}
/** A template with parameters, as the overlap refusal compares it with the others of its method. */
interface Template<D> {
  /** The route it serves. */
  route: Route<D>;
  /** Its segments after the leading slash. */
  segments: readonly string[];
  /** Its rou3 pattern: `/v1/notes/:noteId`. */
  pattern: string;
}
/**
 * Two templates of one method that match a common path, in the order a refusal names them: from the last
 * segment where one is fixed and the other a parameter, the fixed one first.
 */
function overlapping<D>(left: Template<D>, right: Template<D>): [Template<D>, Template<D>] | undefined {
  if (left.segments.length !== right.segments.length || !routesOverlap(left.pattern, right.pattern)) {
    return undefined;
  }
  for (let index = left.segments.length - 1; index >= 0; index -= 1) {
    const leftFixed = !left.segments[index]?.startsWith('{');
    if (leftFixed !== !right.segments[index]?.startsWith('{')) {
      return leftFixed ? [left, right] : [right, left];
    }
  }
  return [left, right];
}
/** A matched route: its definition and its decoded path parameters. */
export interface HttpRouteMatch<D> {
  /** The matched route's definition, as it was passed to the resolver. */
  definition: D;
  /** Each path parameter's decoded value, keyed by its name in the template. */
  parameters: Readonly<Record<string, string>>;
}

/**
 * The router for a set of definitions: `match(method, path)` finds the one route a request reaches, with its
 * decoded parameters, and `ownsPath(path)` says whether any route answers a path. A definition without `http`
 * is skipped. Construction throws a TypeError for an unsupported method, a malformed template, a duplicate
 * route, or two templates that could match the same path; a fixed route may share its path with a template,
 * and wins it. Matching is rou3's route tree, fixed segments before parameters.
 */
export function createHttpRouteResolver<D extends HttpRouteDefinition>(definitions: readonly D[]) {
  const router = createRouter<Route<D>>();
  const fixed = new Set<string>();
  const shapes = new Map<string, Route<D>>();
  const templates = new Map<string, Template<D>[]>();
  for (const definition of definitions) {
    if (!definition.http) {
      continue;
    }
    const { method, path } = definition.http;
    if (!HTTP_METHODS.has(method)) {
      throw new TypeError(`Operation routes require a supported HTTP method: ${method} ${path}`);
    }
    const names = operationPathParameters(path);
    const segments = path.slice(1).split('/');
    const route: Route<D> = {
      definition,
      parameters: segments.flatMap((segment, position) => {
        const parameter = segment.startsWith('{') ? segment.slice(1, -1) : undefined;
        return parameter ? [{ name: parameter, position }] : [];
      }),
    };
    if (names.length === 0) {
      const key = `${method} ${path}`;
      if (fixed.has(key)) {
        throw new TypeError(`Duplicate operation route: ${key}`);
      }
      fixed.add(key);
      addRoute(router, method, path, route);
      continue;
    }
    // The same template under other parameter names: one tree node, two routes.
    const shape = `${method} ${path.replaceAll(/\{\w+\}/g, '{}')}`;
    const same = shapes.get(shape);
    if (same) {
      throw new TypeError(`Ambiguous operation path templates: ${routeName(same)} and ${routeName(route)}`);
    }
    shapes.set(shape, route);
    const template: Template<D> = { route, segments, pattern: path.replaceAll(/\{(\w+)\}/g, ':$1') };
    templates.set(method, [...(templates.get(method) ?? []), template]);
    addRoute(router, method, template.pattern, route);
  }
  for (const declared of templates.values()) {
    for (const [index, template] of declared.entries()) {
      for (const other of declared.slice(0, index)) {
        const pair = overlapping(other, template);
        if (pair) {
          throw new TypeError(
            `Ambiguous overlapping operation path templates: ${routeName(pair[0].route)} and ${routeName(pair[1].route)}`
          );
        }
      }
    }
  }
  /**
   * The route for a method and the path's segments. An empty segment matches none, where rou3 would ignore a
   * trailing slash.
   */
  function routeOf(method: string, segments: readonly string[]): Route<D> | null {
    if (segments.some((segment) => !segment)) {
      return null;
    }
    return findRoute(router, method, `/${segments.join('/')}`, { params: false })?.data ?? null;
  }
  /**
   * The route a request reaches, with its path parameters: every segment is decoded before it is matched, so
   * `/v1/notes/%61rchive` is `/v1/notes/archive` and reaches its route, never a sibling `{noteId}` as the
   * value `archive`. Null when none matches, or a segment is empty or decodes to an unsafe value.
   */
  function match(method: string, path: string): HttpRouteMatch<D> | null {
    if (!path.startsWith('/')) {
      return null;
    }
    const segments: string[] = [];
    for (const segment of path.slice(1).split('/')) {
      const decoded = decodePathParameter(segment);
      if (decoded === null) {
        return null;
      }
      segments.push(decoded);
    }
    const route = routeOf(method, segments);
    if (!route) {
      return null;
    }
    const parameters: Record<string, string> = {};
    for (const parameter of route.parameters) {
      parameters[parameter.name] = segments[parameter.position] ?? '';
    }
    return { definition: route.definition, parameters };
  }
  return {
    match,
    /** Whether any route answers a declared path, so a transport cannot claim an operation's path. */
    ownsPath(path: string): boolean {
      const segments = path.slice(1).split('/');
      return [...HTTP_METHODS].some((method) => routeOf(method, segments) !== null);
    },
  };
}
