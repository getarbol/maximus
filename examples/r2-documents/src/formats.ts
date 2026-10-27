/**
 * The formats the service accepts. A document's bytes must match the content type it is uploaded with: a
 * file is never stored for what it claims to be alone.
 */

/** Whether the bytes begin with this signature. */
function hasSignature(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.byteLength < signature.length) {
    return false;
  }
  return signature.every((byte, index) => bytes[index] === byte);
}

/** Whether the bytes are UTF-8 text without NUL characters. */
function isText(bytes: Uint8Array): boolean {
  try {
    return !new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes).includes('\0');
  } catch {
    return false;
  }
}

/** Each accepted media type, and whether bytes are a file of that type. */
const ACCEPTED_FORMATS = new Map<string, (bytes: Uint8Array) => boolean>([
  ['application/pdf', (bytes) => hasSignature(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])],
  ['image/png', (bytes) => hasSignature(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ['image/jpeg', (bytes) => hasSignature(bytes, [0xff, 0xd8, 0xff])],
  ['text/plain', (bytes) => bytes.byteLength > 0 && isText(bytes)],
]);

/**
 * The media type of a `content-type` header the bytes match, without its parameters; undefined when the
 * service does not accept the type or the bytes are not a file of it.
 */
export function acceptedFormat(contentType: string, bytes: Uint8Array): string | undefined {
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const isFileOfType = ACCEPTED_FORMATS.get(mediaType);
  if (!isFileOfType?.(bytes)) {
    return undefined;
  }
  return mediaType;
}
