/**
 * `@arbol-ai/maximus/webhooks`: webhook signature verification for the three schemes providers actually use.
 *
 * - {@link verifyHmacSignature}: an HMAC-SHA256 of the raw body, hex or base64,
 *   in one header (the common `X-…-Signature` / `X-Hub-Signature-256` scheme).
 * - {@link verifyTimestampedSignature}: `t=<unix>,v1=<hex>` headers signing
 *   `<t>.<body>` (the Stripe-style scheme; some providers label it `v0`).
 * - {@link verifyStandardWebhook}: the Standard Webhooks specification
 *   (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64> …`),
 *   used by many webhook platforms; `svix-*` header names are accepted too.
 *
 * Every comparison runs through `crypto.subtle.verify`, so there is no userland
 * timing leak. Timestamps are checked in both directions (a signed request
 * from the future is as suspicious as a replayed one). Call these on the raw
 * body, before parsing it; a failure carries only a closed reason, never the
 * body, a header value or the secret.
 *
 * Sources: https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md,
 * https://docs.stripe.com/webhooks#verify-manually.
 */
import type { Failure } from './errors.ts';
import type { Result } from './result.ts';

/** Why a webhook signature was refused: absent, malformed, outside the time tolerance, or not matching. */
export const WEBHOOK_SIGNATURE_FAILURES = ['missing', 'malformed', 'expired', 'mismatch'] as const;
/** Why a webhook signature was refused. */
export type WebhookSignatureFailureReason = (typeof WEBHOOK_SIGNATURE_FAILURES)[number];
/** A refused webhook signature, carrying only its reason. */
export interface WebhookSignatureFailure extends Failure<{ reason: WebhookSignatureFailureReason }> {
  /**
   * The one code of every refused signature; `data.reason` says whether it was missing, malformed, expired or
   * mismatched.
   */
  code: 'WEBHOOK_SIGNATURE_INVALID';
}

/** The failure for a refused webhook signature. */
export function webhookSignatureFailure(reason: WebhookSignatureFailureReason): WebhookSignatureFailure {
  return {
    code: 'WEBHOOK_SIGNATURE_INVALID',
    message: 'Webhook signature could not be verified',
    retryable: false,
    data: { reason },
  };
}

/** Five minutes either way, the Standard Webhooks recommendation. */
export const DEFAULT_TOLERANCE_SECONDS = 300;
/**
 * The most signatures one header may carry. A provider rotating its secret sends two or three, and each
 * costs an HMAC of the whole body, so a header with more is refused as malformed before any is computed.
 */
export const MAX_SIGNATURES = 8;

/** Encodes the signed text as UTF-8. */
const encoder = new TextEncoder();

/** Text as UTF-8 bytes, or a copy of the bytes, as Web Crypto takes them. */
function bytes(value: string | Uint8Array): Uint8Array<ArrayBuffer> {
  if (typeof value === 'string') {
    return encoder.encode(value);
  }
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

/** The parts as one byte array. */
function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

/** The bytes of a hexadecimal signature, or null when it is not one. */
function fromHex(value: string): Uint8Array<ArrayBuffer> | null {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) {
    return null;
  }
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

/** The bytes of a base64 or base64url value, or null when it is not one. */
function fromBase64(value: string): Uint8Array<ArrayBuffer> | null {
  if (value.length === 0 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    return null;
  }
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '='));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

/** An HMAC-SHA256 key that can only verify. */
async function hmacKey(secret: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return await crypto.subtle.importKey('raw', secret, { hash: 'SHA-256', name: 'HMAC' }, false, ['verify']);
}

/** Whether a signed timestamp is within the tolerance of now, in either direction. */
function withinTolerance(timestampSeconds: number, toleranceSeconds: number, nowMs: number): boolean {
  return Math.abs(nowMs / 1000 - timestampSeconds) <= toleranceSeconds;
}

/** A refusal with its reason. */
const failure = (reason: WebhookSignatureFailureReason): Result<never, WebhookSignatureFailure> => ({
  ok: false,
  error: webhookSignatureFailure(reason),
});

/**
 * Verify an HMAC-SHA256 of the raw body. `signature` is the header value,
 * optionally with a scheme prefix such as `sha256=` (removed with `prefix`).
 */
export async function verifyHmacSignature(options: {
  body: string | Uint8Array;
  encoding: 'hex' | 'base64';
  prefix?: string;
  secret: string | Uint8Array;
  signature: string | null | undefined;
}): Promise<Result<null, WebhookSignatureFailure>> {
  if (!options.signature) {
    return failure('missing');
  }
  const value =
    options.prefix && options.signature.startsWith(options.prefix)
      ? options.signature.slice(options.prefix.length)
      : options.signature;
  const signature = options.encoding === 'hex' ? fromHex(value.trim()) : fromBase64(value.trim());
  if (!signature) {
    return failure('malformed');
  }
  const valid = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(bytes(options.secret)),
    signature,
    bytes(options.body)
  );
  return valid ? { ok: true, value: null } : failure('mismatch');
}

/**
 * Verify a `t=<unix seconds>,v0=<hex>` header (several `v0`/`v1` values may be
 * present during secret rotation, up to {@link MAX_SIGNATURES}; one match is
 * enough) signing `<t>.<body>`.
 */
export async function verifyTimestampedSignature(options: {
  body: string | Uint8Array;
  header: string | null | undefined;
  /** The signature labels to accept, for example `['v1']` or `['v0']`. */
  labels: readonly string[];
  now?: () => number;
  secret: string | Uint8Array;
  toleranceSeconds?: number;
}): Promise<Result<{ timestamp: number }, WebhookSignatureFailure>> {
  if (!options.header) {
    return failure('missing');
  }
  let timestamp: number | null = null;
  const signatures: Uint8Array<ArrayBuffer>[] = [];
  for (const part of options.header.split(',')) {
    const separator = part.indexOf('=');
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (separator < 1) {
      continue;
    }
    if (key === 't' && /^\d{1,12}$/.test(value)) {
      timestamp = Number(value);
    } else if (options.labels.includes(key)) {
      const decoded = fromHex(value);
      if (decoded) {
        signatures.push(decoded);
      }
    }
  }
  if (timestamp === null || signatures.length === 0 || signatures.length > MAX_SIGNATURES) {
    return failure('malformed');
  }
  const now = options.now?.() ?? Date.now();
  if (!withinTolerance(timestamp, options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS, now)) {
    return failure('expired');
  }
  const key = await hmacKey(bytes(options.secret));
  const message = concat(encoder.encode(`${timestamp}.`), bytes(options.body));
  for (const signature of signatures) {
    if (await crypto.subtle.verify('HMAC', key, signature, message)) {
      return { ok: true, value: { timestamp } };
    }
  }
  return failure('mismatch');
}

/**
 * Verify a Standard Webhooks delivery. The secret is the provider's
 * `whsec_<base64>` value (the prefix is optional), and the signature header may
 * list up to {@link MAX_SIGNATURES} signatures. Returns the message id, the
 * idempotency key of the delivery, and its timestamp.
 */
export async function verifyStandardWebhook(options: {
  body: string | Uint8Array;
  headers: Pick<Headers, 'get'>;
  now?: () => number;
  secret: string;
  toleranceSeconds?: number;
}): Promise<Result<{ id: string; timestamp: number }, WebhookSignatureFailure>> {
  /** A Standard Webhooks header, or its `svix-` spelling. */
  const header = (name: string) =>
    options.headers.get(`webhook-${name}`) ?? options.headers.get(`svix-${name}`);
  const id = header('id');
  const timestampValue = header('timestamp');
  const signatureValue = header('signature');
  if (!(id && timestampValue && signatureValue)) {
    return failure('missing');
  }
  if (!/^\d{1,12}$/.test(timestampValue) || id.length > 256 || /[\s.]/.test(id)) {
    return failure('malformed');
  }
  const timestamp = Number(timestampValue);
  const now = options.now?.() ?? Date.now();
  if (!withinTolerance(timestamp, options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS, now)) {
    return failure('expired');
  }
  const secret = fromBase64(options.secret.startsWith('whsec_') ? options.secret.slice(6) : options.secret);
  if (!secret) {
    return failure('malformed');
  }
  const signatures = signatureValue.split(' ').flatMap((entry) => {
    const [version, value] = entry.split(',', 2);
    const decoded = version === 'v1' && value ? fromBase64(value) : null;
    return decoded ? [decoded] : [];
  });
  if (signatures.length === 0 || signatures.length > MAX_SIGNATURES) {
    return failure('malformed');
  }
  const key = await hmacKey(secret);
  const message = concat(encoder.encode(`${id}.${timestamp}.`), bytes(options.body));
  for (const signature of signatures) {
    if (await crypto.subtle.verify('HMAC', key, signature, message)) {
      return { ok: true, value: { id, timestamp } };
    }
  }
  return failure('mismatch');
}
