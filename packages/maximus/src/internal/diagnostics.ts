/**
 * Safe error descriptions for diagnostics: an error's known names, its causes' names, its issue count and
 * its stack locations, never a message.
 */

/** Built-in identities only; each consumer supplies its domain error names. */
export const BUILTIN_ERROR_NAMES = [
  'AbortError',
  'AggregateError',
  'DOMException',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TimeoutError',
  'TypeError',
  'URIError',
] as const;

/** Read a diagnostic property without letting a getter or Proxy break recovery. */
export function errorProperty(value: unknown, key: string): unknown {
  try {
    return typeof value === 'object' && value !== null && key in value ? Reflect.get(value, key) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What diagnostics may say about an error: its name, its causes' names, its issue count and its stack
 * locations.
 */
export interface ErrorDescription {
  /**
   * The error's name when it is a built-in or supplied domain name, else `UnknownError`; `NonError` when the
   * thrown value is not an `Error`.
   */
  name: string;
  /**
   * The names of up to three errors in its `cause` chain, nearest first, each a known name or `UnknownError`;
   * absent without a cause.
   */
  causes?: string[];
  /**
   * How many entries the error's `issues` array holds, or its direct cause's; absent when neither has one.
   */
  issueCount?: number;
  /**
   * Line and column numbers of up to eight stack frames, from the top, without file names; absent when the
   * stack yields none.
   */
  locations?: { line: number; column: number }[];
}

/**
 * Create a pure projection for SDK events and owner-written log lines. Names are
 * developer constants, never values taken from an upstream response. Messages,
 * record keys, URLs and query parameters are never returned. No logging occurs.
 */
export function createDiagnostics(errorNames: readonly string[] = []) {
  const names = new Set<string>([...BUILTIN_ERROR_NAMES, ...errorNames]);
  /** The error's name when it is a known one, else `UnknownError`. */
  function safeErrorName(error: unknown): string {
    const name = errorProperty(error, 'name');
    return typeof name === 'string' && names.has(name) ? name : 'UnknownError';
  }
  /**
   * The error's safe description: names, up to three cause names, its issue count and up to eight stack
   * locations, never a message.
   */
  function describeError(error: unknown): ErrorDescription {
    if (!(error instanceof Error)) {
      return { name: 'NonError' };
    }
    const result: ErrorDescription = { name: safeErrorName(error) };
    const seen = new Set<unknown>([error]);
    let current = errorProperty(error, 'cause');
    const causes: string[] = [];
    while (current && !seen.has(current) && causes.length < 3) {
      seen.add(current);
      causes.push(safeErrorName(current));
      current = errorProperty(current, 'cause');
    }
    if (causes.length) {
      result.causes = causes;
    }
    const issues = errorProperty(error, 'issues') ?? errorProperty(errorProperty(error, 'cause'), 'issues');
    if (Array.isArray(issues)) {
      result.issueCount = issues.length;
    }
    const stack = errorProperty(error, 'stack');
    const name = errorProperty(error, 'name');
    const message = errorProperty(error, 'message');
    let heading: string | undefined;
    if (typeof name === 'string') {
      heading = typeof message === 'string' && message ? `${name}: ${message}` : name;
    }
    if (typeof heading === 'string' && typeof stack === 'string' && stack.startsWith(`${heading}\n`)) {
      const locations: NonNullable<ErrorDescription['locations']> = [];
      for (const frame of stack.slice(heading.length + 1, heading.length + 4001).split('\n')) {
        const match = frame.startsWith('    at ') ? /:(\d+):(\d+)\)?$/.exec(frame) : null;
        if (!match) {
          continue;
        }
        const line = Number(match[1]);
        const column = Number(match[2]);
        if (line > 0 && line <= 10_000_000 && column > 0 && column <= 10_000_000) {
          locations.push({ line, column });
        }
        if (locations.length === 8) {
          break;
        }
      }
      if (locations.length) {
        result.locations = locations;
      }
    }
    return result;
  }
  return { safeErrorName, describeError };
}
