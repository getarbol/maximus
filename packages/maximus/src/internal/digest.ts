/**
 * SHA-256 digests in hexadecimal, for rate limit keys, the development token's comparison and skill
 * manifests.
 */

/** The SHA-256 digest of text or bytes, in lowercase hexadecimal. */
export async function sha256Hex(value: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
