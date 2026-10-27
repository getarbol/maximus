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

/** Why a byte body could not be read: it exceeds the limit, it is compressed, or it broke off. */
export type BodyFailure = Failure & {
  code: 'REQUEST_TOO_LARGE' | 'UNSUPPORTED_MEDIA_TYPE' | 'INVALID_INPUT';
};

/** The raw body of an operation declared with `http.body: 'bytes'`, read on demand. */
export interface BinaryBody {
  /**
   * Reads the body within the operation's byte limit, once: every call answers the first read's result.
   * `UNSUPPORTED_MEDIA_TYPE` for a compressed body, `REQUEST_TOO_LARGE` beyond the limit and `INVALID_INPUT`
   * for a malformed length or a body that broke off or was aborted. Call it once the handler has admitted the
   * resource the body is for.
   */
  read: () => Promise<Result<Uint8Array<ArrayBuffer>, BodyFailure>>;
}

/**
 * The on-demand reader of a request's byte body, held to `maxBytes`. Creating it reads nothing and records
 * nothing of the request.
 */
export function binaryBody(request: Request, maxBytes: number): BinaryBody {
  let reading: Promise<Result<Uint8Array<ArrayBuffer>, BodyFailure>> | undefined;
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

/**
 * Whether an output is a well-formed `Attachment` within `maxBytes`: exactly its four fields, bytes of
 * exactly `byteLength` or an unlocked stream, a `type/subtype` media type of at most 255 characters, and a
 * filename of 1 to 512 characters without control characters, slashes or backslashes. Execution checks it
 * before anything is sent.
 */
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

/**
 * The response that serves an attachment: its bytes with `content-type`, `content-length`, an RFC 8187
 * `content-disposition`, `cache-control: private, no-store`, a sandboxing `content-security-policy` and
 * `x-content-type-options: nosniff`. A stream is held to exactly `byteLength` bytes, so a handler can send
 * neither more nor fewer than it declared.
 */
export function attachmentResponse(file: Attachment, status = 200): Response {
  // RFC 8187 excludes these characters even though encodeURIComponent leaves them unchanged.
  const encodedFilename = encodeURIComponent(file.filename).replaceAll(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  const body: BodyInit =
    file.body instanceof Uint8Array
      ? (file.body as Uint8Array<ArrayBuffer>)
      : exactLength(file.body, file.byteLength);
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
