/**
 * Request correlation: request ids (a UUID, or a ray id from a trusted Cloudflare edge), W3C `traceparent`
 * parsing, and the correlation that durable work persists.
 */

/** A UUID in its canonical text form. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A Cloudflare ray id, with its optional data center suffix. */
const RAY_PATTERN = /^[0-9a-f]{16}(?:-[A-Z]{3})?$/;

/**
 * Whether a value is a request id: a UUID or a Cloudflare ray id. A request id correlates diagnostics; never
 * use one as authority or as a deduplication key.
 */
export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && (UUID_PATTERN.test(value) || RAY_PATTERN.test(value));
}

/**
 * A request id: `trustedEdgeRay` when it is a valid request id, otherwise a random UUID. Pass a ray id only
 * from the Cloudflare edge or from a caller authenticated separately, never an `x-request-id` or `cf-ray`
 * value an untrusted caller sent.
 */
export function createRequestId(trustedEdgeRay?: string | null): string {
  return isRequestId(trustedEdgeRay) ? trustedEdgeRay : crypto.randomUUID();
}

/**
 * A parsed W3C `traceparent` header of version 00. Parsing one starts no span, decides no sampling and
 * authenticates nothing.
 */
export interface TraceParent {
  /** The trace id: 32 lowercase hexadecimal characters, never all zeros. */
  traceId: string;
  /** The caller's span id, the header's `parent-id`: 16 lowercase hexadecimal characters, never all zeros. */
  parentSpanId: string;
  /** Whether the header's trace flags set the sampled bit; the caller's hint, not a sampling decision. */
  sampled: boolean;
}
/** Reads a W3C `traceparent` header of version 00, or nothing when it is malformed or all zeros. */
export function parseTraceParent(value: string | null | undefined): TraceParent | undefined {
  const match = value && /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value);
  if (!match?.[1] || !match[2] || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) {
    return;
  }
  return {
    traceId: match[1],
    parentSpanId: match[2],
    sampled: (Number.parseInt(match[3] ?? '00', 16) & 1) === 1,
  };
}

/**
 * The correlation durable work persists with its domain data, so each later attempt can be tied to the
 * request that started it: the owner starts a span for each attempt and links it to the origin, rather than
 * keeping the request's span open. No principal, token, baggage, arguments or customer ids belong in it.
 */
export interface DurableCorrelation {
  /** The id of the request that started the work: a UUID or a Cloudflare ray id. */
  requestId: string;
  /**
   * The originating request's W3C `traceparent`, which a new attempt span links to; absent when there was
   * none or it did not parse.
   */
  originTraceParent?: string;
}
/**
 * The correlation to persist with durable work: a valid request id and, when it parses, the originating
 * `traceparent`. A request id that is not one throws a TypeError.
 */
export function durableCorrelation(requestId: string, originTraceParent?: string): DurableCorrelation {
  if (!isRequestId(requestId)) {
    throw new TypeError('Invalid correlation id');
  }
  return {
    requestId,
    ...(parseTraceParent(originTraceParent) ? { originTraceParent } : {}),
  };
}
