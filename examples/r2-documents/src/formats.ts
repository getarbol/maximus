/**
 * The formats the service accepts. A document's bytes must match the content type it is uploaded with: a
 * file is never stored for what it claims to be alone.
 */

/** Whether the bytes begin with these. */
const startsWith = (bytes: Uint8Array, signature: readonly number[]) =>
  bytes.byteLength >= signature.length && signature.every((byte, index) => bytes[index] === byte);

/** Whether the bytes are UTF-8 text without NUL characters. */
function isText(bytes: Uint8Array): boolean {
  try {
    return !new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes).includes('\0');
  } catch {
    return false;
  }
}

/** Each accepted media type, and whether bytes are a file of that type. */
const FORMATS: Readonly<Record<string, (bytes: Uint8Array) => boolean>> = {
  'application/pdf': (bytes) => startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]),
  'image/png': (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  'text/plain': (bytes) => bytes.byteLength > 0 && isText(bytes),
};

/**
 * The media type of a `content-type` header the bytes match, without its parameters; undefined when the
 * service does not accept the type or the bytes are not a file of it.
 */
export function acceptedFormat(contentType: string, bytes: Uint8Array): string | undefined {
  const type = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return Object.hasOwn(FORMATS, type) && FORMATS[type]?.(bytes) ? type : undefined;
}
