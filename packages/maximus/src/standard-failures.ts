/**
 * `@arbol-ai/maximus/failures`: the framework's own failures as plain data: code, HTTP status,
 * message, retryability and Retry-After. No runtime and no schema library, for a dispatcher that presents
 * them, such as an API gateway. `defineErrors` builds their schemas from this same table.
 */

/** One of the framework's own failures. */
export interface StandardFailure {
  /** The stable code clients branch on, such as `RATE_LIMITED`. */
  readonly code: string;
  /** The HTTP status that answers it. */
  readonly status: number;
  /** A fixed message for people; it never carries request data. */
  readonly message: string;
  /** Whether the same request may succeed later; false when absent. */
  readonly retryable?: boolean;
  /** The seconds a client waits before retrying, sent as `Retry-After`. */
  readonly retryAfter?: number;
}

/** The framework's own failures, by the name `standardErrors` gives each. */
export const STANDARD_FAILURES = {
  invalidInput: {
    code: 'INVALID_INPUT',
    status: 400,
    message: 'The request does not match the published schema.',
  },
  unauthorized: {
    code: 'UNAUTHORIZED',
    status: 401,
    message: 'A valid access token is required.',
  },
  forbidden: { code: 'FORBIDDEN', status: 403, message: 'The token does not authorize this operation.' },
  notFound: { code: 'NOT_FOUND', status: 404, message: 'The requested operation does not exist.' },
  methodNotAllowed: {
    code: 'HTTP_METHOD_NOT_ALLOWED',
    status: 405,
    message: 'The HTTP method is not supported for this resource.',
  },
  tooLarge: { code: 'REQUEST_TOO_LARGE', status: 413, message: 'The request exceeds the allowed size.' },
  unsupportedMedia: {
    code: 'UNSUPPORTED_MEDIA_TYPE',
    status: 415,
    message: 'The request content type is not supported.',
  },
  rateLimited: {
    code: 'RATE_LIMITED',
    status: 429,
    message: 'The request rate limit was exceeded. Try again later.',
    retryable: true,
    retryAfter: 60,
  },
  internal: { code: 'INTERNAL_ERROR', status: 500, message: 'The service could not complete the operation.' },
  upstreamUnavailable: {
    code: 'UPSTREAM_UNAVAILABLE',
    status: 503,
    message: 'The upstream service could not complete the request.',
    retryable: true,
  },
  upstreamTimeout: {
    code: 'UPSTREAM_TIMEOUT',
    status: 504,
    message: 'The upstream service did not respond before its deadline.',
    retryable: true,
  },
  /**
   * A write may have been applied and its answer was lost. Never retried: the caller reconciles (reads
   * the resource or polls the operation) before deciding to repeat anything.
   */
  outcomeUnknown: {
    code: 'OUTCOME_UNKNOWN',
    status: 502,
    message: 'The operation may have been applied; check its result before repeating it.',
  },
} as const satisfies Record<string, StandardFailure>;
