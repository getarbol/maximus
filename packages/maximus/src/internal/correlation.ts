/**
 * Request correlation: request ids (a UUID, or a ray id from a trusted Cloudflare edge), W3C `traceparent`
 * parsing, and the correlation that durable work persists.
 */

/** A UUID in its canonical text form. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A Cloudflare ray id, with its optional data center suffix. */
const RAY_PATTERN = /^[0-9a-f]{16}(?:-[A-Z]{3})?$/;

/** Only technical support identifiers. Never use these values as authority or dedupe keys. */
export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && (UUID_PATTERN.test(value) || RAY_PATTERN.test(value));
}

/**
 * Public ingress mints an id by default. Only pass trustedEdgeRay from the
 * Cloudflare edge or a separately authenticated internal caller; arbitrary
 * X-Request-Id/CF-Ray supplied by an untrusted caller must not be adopted.
 */
export function createRequestId(trustedEdgeRay?: string | null): string {
  return isRequestId(trustedEdgeRay) ? trustedEdgeRay : crypto.randomUUID();
}

/** W3C v00 only. Parsing is not SDK span activation, sampling approval or authentication. */
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
 * Durable correlation is persisted with domain work; it does not keep a request
 * span open for hours. The owner starts a new attempt span and links it to origin.
 * No principal, bearer, baggage, arguments or customer ids belong in this object.
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
 * `traceparent`.
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
