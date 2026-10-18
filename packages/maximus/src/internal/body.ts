/**
 * Bounded readers of Web bodies: bytes or UTF-8 text up to a byte limit, chunked bodies included, with
 * every expected failure returned as a Result.
 */
import type { Failure } from '../errors.ts';
import type { Result } from '../result.ts';

/** Closed decoding vocabulary used by bounded transport readers. */
export const HTTP_BODY_FAILURES = [
  'too_large',
  'invalid_length',
  'invalid_json',
  'invalid_utf8',
  'unexpected_content_type',
  'aborted',
  'read_failed',
] as const;
/** Why a body could not be read. */
export type HttpBodyFailureReason = (typeof HTTP_BODY_FAILURES)[number];
/** A body that could not be read, with its reason. */
export interface HttpBodyFailure extends Failure<{ reason: HttpBodyFailureReason }> {
  /** The one code every body read failure carries; `data.reason` says why the body could not be read. */
  code: 'HTTP_BODY_INVALID';
}

/** Construct only closed decoder metadata. No exception, input bytes or telemetry. */
export function httpBodyFailure(reason: HttpBodyFailureReason): HttpBodyFailure {
  if (!HTTP_BODY_FAILURES.includes(reason)) {
    throw new TypeError('Invalid HTTP body reason');
  }
  return {
    code: 'HTTP_BODY_INVALID',
    message: 'HTTP body could not be decoded',
    retryable: false,
    data: { reason },
  };
}

/** How much of a body to read, and until when. */
export interface BodyReadOptions {
  /** The most body bytes to read, a positive safe integer; a longer body fails as `too_large`. */
  maxBytes: number;
  /** Pass the same deadline to fetch and the reader for outbound requests. */
  signal?: AbortSignal;
}
/** What a body is read from: a request or a response. */
type BodySource = Pick<Request, 'body' | 'headers'>;

/**
 * Read at most the owner's byte limit, including chunked bodies. Returns original
 * bytes for signature verification. Expected decoding failures are plain results.
 * Rejected streams are cancelled without awaiting a remote acknowledgement.
 */
export async function readBodyBytes(
  source: BodySource,
  options: BodyReadOptions
): Promise<Result<Uint8Array<ArrayBuffer>, HttpBodyFailure>> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new RangeError('Invalid body byte limit');
  }
  /** Refuses before reading, cancelling the body without waiting for it. */
  const reject = (reason: HttpBodyFailureReason): Result<never, HttpBodyFailure> => {
    void source.body?.cancel().catch(() => {});
    return { ok: false, error: httpBodyFailure(reason) };
  };
  if (options.signal?.aborted) {
    return reject('aborted');
  }
  const length = source.headers.get('content-length');
  if (length !== null && !/^\d+$/.test(length)) {
    return reject('invalid_length');
  }
  if (length !== null && Number(length) > options.maxBytes) {
    return reject('too_large');
  }
  const reader = source.body?.getReader();
  if (!reader) {
    return { ok: true, value: new Uint8Array(0) };
  }
  /** Cancels the read, without waiting for the remote side. */
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  /** Refuses while reading, cancelling the rest of the body. */
  const fail = (reason: HttpBodyFailureReason): Result<never, HttpBodyFailure> => {
    cancel();
    return { ok: false, error: httpBodyFailure(reason) };
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (options.signal?.aborted) {
        return fail('aborted');
      }
      const chunk = await reader.read();
      if (options.signal?.aborted) {
        return fail('aborted');
      }
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > options.maxBytes) {
        return fail('too_large');
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, value: bytes };
  } catch {
    return fail(options.signal?.aborted ? 'aborted' : 'read_failed');
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/** Decode bounded UTF-8; signed text adapters can retain vendor replacement semantics. */
export async function readBodyText(
  source: BodySource,
  options: BodyReadOptions & { fatalUtf8?: boolean }
): Promise<Result<string, HttpBodyFailure>> {
  const bytes = await readBodyBytes(source, options);
  if (!bytes.ok) {
    return bytes;
  }
  try {
    return {
      ok: true,
      value: new TextDecoder('utf-8', {
        fatal: options.fatalUtf8 ?? true,
      }).decode(bytes.value),
    };
  } catch {
    return { ok: false, error: httpBodyFailure('invalid_utf8') };
  }
}

/** Verify the signature on the exact successful text before parsing signed input. */
export function readWebhookBody(
  request: Request,
  maxBytes: number
): Promise<Result<string, HttpBodyFailure>> {
  return readBodyText(request, {
    maxBytes,
    signal: request.signal,
    fatalUtf8: false,
  });
}
