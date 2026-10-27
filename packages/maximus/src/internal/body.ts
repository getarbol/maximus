/**
 * Bounded readers of Web bodies: bytes or UTF-8 text up to a byte limit, chunked bodies included, with
 * every expected failure returned as a Result.
 */
import type { Failure } from '../errors.ts';
import type { Result } from '../result.ts';

/** Every reason a bounded read can fail with: the values of a body failure's `data.reason`. */
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

/**
 * The body failure for a reason: `HTTP_BODY_INVALID`, with the reason as its only data and nothing of the
 * body. A reason outside `HTTP_BODY_FAILURES` throws a TypeError.
 */
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
  /**
   * The most body bytes to read, a positive safe integer; a longer body fails as `too_large`, and any other
   * value throws a RangeError.
   */
  maxBytes: number;
  /**
   * Aborts the read, which then fails as `aborted`. For a response, pass the signal its `fetch` used, so one
   * deadline covers the request and its body.
   */
  signal?: AbortSignal;
}
/** What a body is read from: a request or a response. */
type BodySource = Pick<Request, 'body' | 'headers'>;

/**
 * Reads a request's or a response's body as bytes, at most `maxBytes` of them, chunked bodies included, and
 * answers them unchanged, as a signature check needs them; an absent body is no bytes. A `content-length`
 * that is malformed or above the limit is refused before reading. Every expected failure is a result
 * (`too_large`, `invalid_length`, `aborted` or `read_failed`), and a refused body is cancelled without
 * waiting for the other side.
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
      // A deadline before the first read was refused above; one that fires while a read waits cancels it.
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

/**
 * Reads a body as `readBodyBytes` does and decodes it as UTF-8. Invalid UTF-8 fails as `invalid_utf8`,
 * unless `fatalUtf8: false` replaces it with U+FFFD, as a provider that signs its decoded text may require.
 */
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
