/**
 * `@arbol-ai/maximus/http-paths`: versioned route templates, path parameter decoding, and the router that
 * matches a request to exactly one operation.
 */

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

/** Parse declared templates, never caller paths. Parameters occupy one complete path segment. */
export function operationPathParameters(path: string): string[] {
  const segments = path.split('/');
  if (segments[0] !== '' || !/^v[1-9][0-9]*$/.test(segments[1] ?? '') || segments.length < 3) {
    throw new TypeError('Operations require a versioned path.');
  }
  const parameters: string[] = [];
  for (const segment of segments.slice(2)) {
    const parameter = PARAMETER_SEGMENT.exec(segment)?.[1];
    if (parameter) {
      if (UNSAFE_PARAMETERS.has(parameter) || parameters.includes(parameter)) {
        throw new TypeError('Path parameter names must be unique and safe.');
      }
      parameters.push(parameter);
    } else if (!STATIC_SEGMENT.test(segment)) {
      throw new TypeError(
        'Use fixed routes or complete {parameter} segments; empty and malformed segments are forbidden.'
      );
    }
  }
  return parameters;
}

/** A decoded item key stays in one segment; dot segments and controls cannot alter URL ownership. */
export function decodePathParameter(segment: string): string | null {
  try {
    const value = decodeURIComponent(segment);
    return isPathParameterValue(value) ? value : null;
  } catch {
    return null;
  }
}

/** Item keys are nonempty strings that cannot change URL path ownership when encoded. */
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
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) {
      return false;
    }
  }
  return true;
}

/** Owner metadata is retained unchanged; schema admission remains the manifest's responsibility. */
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
/**
 * A node of the template tree, as the declarations build it: fixed children, one parameter child and the
 * route ending here.
 */
interface Branch<D> {
  /** Identifies the node within the resolver, so each distinct set of nodes compiles to one shared state. */
  id: number;
  /** The children reached by fixed segments, keyed by the segment's text. */
  fixed: Map<string, Branch<D>>;
  /** The child reached by a `{name}` parameter segment; absent when no template has a parameter here. */
  parameter?: Branch<D>;
  /** The route whose template ends at this node; absent when none does. */
  route?: Route<D>;
}
/** A compiled matching state: each fixed segment and a parameter lead to exactly one next state. */
interface State<D> {
  /**
   * The next state for each fixed segment, keyed by its text; it also continues the templates that take a
   * parameter here.
   */
  fixed: Map<string, State<D>>;
  /**
   * The next state for a segment with no fixed transition, read as a parameter value; absent when no template
   * takes a parameter here.
   */
  parameter?: State<D>;
  /** The route a path ending in this state matches; absent when none ends here. */
  route?: Route<D>;
}
/** A matched route: its definition and its decoded path parameters. */
export interface HttpRouteMatch<D> {
  /** The matched route's definition, as it was passed to the resolver. */
  definition: D;
  /** Each path parameter's decoded value, keyed by its name in the template. */
  parameters: Readonly<Record<string, string>>;
}

/**
 * Exact routes use a Map. Template branches compile into deterministic states at construction:
 * one transition per segment, including overlapping fixed prefixes, with no per-request route scan.
 */
export function createHttpRouteResolver<D extends HttpRouteDefinition>(definitions: readonly D[]) {
  const exact = new Map<string, Route<D>>();
  const roots = new Map<string, Branch<D>>();
  let nextId = 0;
  /** A new tree node with the next id. */
  const branch = (): Branch<D> => {
    const node: Branch<D> = { id: nextId, fixed: new Map() };
    nextId += 1;
    return node;
  };
  for (const definition of definitions) {
    if (!definition.http) {
      continue;
    }
    if (!HTTP_METHODS.has(definition.http.method)) {
      throw new TypeError('Operation routes require a supported HTTP method.');
    }
    const names = operationPathParameters(definition.http.path);
    const segments = definition.http.path.slice(1).split('/');
    const route: Route<D> = {
      definition,
      parameters: segments.flatMap((segment, position) => {
        const parameter = segment.startsWith('{') ? segment.slice(1, -1) : undefined;
        return parameter ? [{ name: parameter, position }] : [];
      }),
    };
    if (names.length === 0) {
      const key = `${definition.http.method} ${definition.http.path}`;
      if (exact.has(key)) {
        throw new TypeError('Duplicate operation route.');
      }
      exact.set(key, route);
      continue;
    }
    let node = roots.get(definition.http.method);
    if (!node) {
      node = branch();
      roots.set(definition.http.method, node);
    }
    for (const segment of segments) {
      if (segment.startsWith('{')) {
        node.parameter ??= branch();
        node = node.parameter;
      } else {
        let child = node.fixed.get(segment);
        if (!child) {
          child = branch();
          node.fixed.set(segment, child);
        }
        node = child;
      }
    }
    if (node.route) {
      throw new TypeError('Ambiguous operation path templates.');
    }
    node.route = route;
  }
  const states = new Map<string, State<D>>();
  /**
   * The state for a set of tree nodes: their routes (at most one), and for each next segment the state of
   * every node it can lead to, compiled once per set.
   */
  function compile(nodes: readonly Branch<D>[]): State<D> {
    const distinct = [...new Map(nodes.map((node) => [node.id, node])).values()];
    const key = distinct
      .map((node) => node.id)
      .toSorted((left, right) => left - right)
      .join(',');
    const known = states.get(key);
    if (known) {
      return known;
    }
    const routes = distinct.flatMap((node) => (node.route ? [node.route] : []));
    if (routes.length > 1) {
      throw new TypeError('Ambiguous overlapping operation path templates.');
    }
    const state: State<D> = { fixed: new Map(), route: routes[0] };
    states.set(key, state);
    const parameters = distinct.flatMap((node) => (node.parameter ? [node.parameter] : []));
    if (parameters.length > 0) {
      state.parameter = compile(parameters);
    }
    const fixed = new Set(distinct.flatMap((node) => [...node.fixed.keys()]));
    for (const segment of fixed) {
      const children = distinct.flatMap((node) => {
        const child = node.fixed.get(segment);
        return child ? [child] : [];
      });
      state.fixed.set(segment, compile([...children, ...parameters]));
    }
    return state;
  }
  const templates = new Map([...roots].map(([method, root]) => [method, compile([root])]));
  /**
   * The route for a method and path: an exact route first, then one transition per segment through the
   * compiled states.
   */
  function findRoute(method: string, path: string): Route<D> | null {
    const fixed = exact.get(`${method} ${path}`);
    if (fixed) {
      return fixed;
    }
    if (!path.startsWith('/') || path.endsWith('/')) {
      return null;
    }
    const segments = path.slice(1).split('/');
    let state = templates.get(method);
    for (const segment of segments) {
      if (!segment || !state) {
        return null;
      }
      state = state.fixed.get(segment) ?? state.parameter;
    }
    return state?.route ?? null;
  }
  /**
   * The route a request reaches, with its path parameters decoded; null when none matches or a parameter
   * value is unsafe.
   */
  function match(method: string, path: string): HttpRouteMatch<D> | null {
    const route = findRoute(method, path);
    if (!route) {
      return null;
    }
    const segments = path.slice(1).split('/');
    const parameters: Record<string, string> = {};
    for (const parameter of route.parameters) {
      const value = decodePathParameter(segments[parameter.position] ?? '');
      if (value === null) {
        return null;
      }
      parameters[parameter.name] = value;
    }
    return { definition: route.definition, parameters };
  }
  return {
    match,
    /** Used only at construction to prevent a transport from bypassing item-route authorization. */
    ownsPath(path: string): boolean {
      return [...HTTP_METHODS].some((method) => findRoute(method, path) !== null);
    },
  };
}
