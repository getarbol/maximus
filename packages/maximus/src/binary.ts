/**
 * Byte bodies and file attachments over HTTP: the on-demand reader of a declared byte body, the checks an
 * attachment output passes before anything is sent, and the exact-length response that serves it.
 */
import { Kind } from '@sinclair/typebox';
import type { TSchema } from '@sinclair/typebox';

import type { Attachment } from './attachment-schema.ts';
import { standardErrors } from './errors.ts';
import type { Failure } from './errors.ts';
import { readBodyBytes } from './internal/body.ts';
import { exactLength } from './internal/exact-length.ts';
import type { Result } from './result.ts';

/** The raw body of an operation declared with `http.body: 'bytes'`, read on demand. */
export interface BinaryBody {
  /** Read once within this operation's byte limit, after the owner admits the target resource. */
  read: () => Promise<Result<Uint8Array<ArrayBuffer>, Failure>>;
}

/** A request-local reader; constructing it never pulls bytes or records headers/content. */
export function binaryBody(request: Request, maxBytes: number): BinaryBody {
  let reading: Promise<Result<Uint8Array<ArrayBuffer>, Failure>> | undefined;
  return {
    read() {
      reading ??= (async () => {
        const encoding = request.headers.get('content-encoding');
        if (encoding && encoding.toLowerCase() !== 'identity') {
          return { ok: false, error: standardErrors.unsupportedMedia.create() };
        }
        const result = await readBodyBytes(request, { maxBytes, signal: request.signal });
        return result.ok
          ? result
          : {
              ok: false,
              error:
                result.error.data.reason === 'too_large'
                  ? standardErrors.tooLarge.create()
                  : standardErrors.invalidInput.create(),
            };
      })();
      return reading;
    },
  };
}

/** Whether an output schema is `AttachmentOutputSchema`. */
export function isAttachmentSchema(schema: TSchema): boolean {
  return schema[Kind] === 'HttpAttachment';
}

/** Reject malformed output before exposing a body, filename or media type to HTTP. */
export function validAttachment(value: unknown, maxBytes: number): value is Attachment {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 4 ||
    keys.some((key) => !['body', 'contentType', 'filename', 'byteLength'].includes(key))
  ) {
    return false;
  }
  const file = value as Attachment;
  if (!(file.body instanceof Uint8Array || file.body instanceof ReadableStream)) {
    return false;
  }
  if (file.body instanceof ReadableStream && file.body.locked) {
    return false;
  }
  if (!Number.isSafeInteger(file.byteLength) || file.byteLength < 0 || file.byteLength > maxBytes) {
    return false;
  }
  if (file.body instanceof Uint8Array && file.body.byteLength !== file.byteLength) {
    return false;
  }
  if (
    typeof file.contentType !== 'string' ||
    file.contentType.length > 255 ||
    !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(file.contentType)
  ) {
    return false;
  }
  if (
    typeof file.filename !== 'string' ||
    !file.filename.length ||
    file.filename.length > 512 ||
    /[\p{Cc}/\\]/u.test(file.filename)
  ) {
    return false;
  }
  try {
    encodeURIComponent(file.filename);
    return true;
  } catch {
    return false;
  }
}

/** An exact-length stream prevents a handler from sending bytes beyond its validated attachment metadata. */
export function attachmentResponse(file: Attachment, status = 200): Response {
  // RFC 8187 excludes these characters even though encodeURIComponent leaves them unchanged.
  const encodedFilename = encodeURIComponent(file.filename).replaceAll(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  const body: BodyInit =
    file.body instanceof Uint8Array
      ? (file.body as Uint8Array<ArrayBuffer>)
      : attachmentStream(file.body, file.byteLength);
  return new Response(body, {
    status,
    headers: {
      'cache-control': 'private, no-store',
      'content-type': file.contentType,
      'content-length': String(file.byteLength),
      'content-disposition': `attachment; filename="${file.filename.replaceAll(/[^\u0020-\u007E]|["\\]/gu, '_')}"; filename*=UTF-8''${encodedFilename}`,
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
    },
  });
}

/** Workers determines Content-Length from the body, ignoring a header on an ordinary stream. */
function attachmentStream(body: ReadableStream<Uint8Array>, byteLength: number): ReadableStream<Uint8Array> {
  const bounded = exactLength(body, byteLength);
  // Keep the standard-stream fallback for runtimes that honor the explicit response header.
  return typeof FixedLengthStream === 'function'
    ? bounded.pipeThrough(new FixedLengthStream(byteLength))
    : bounded;
}
