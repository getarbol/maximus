/**
 * An R2 bucket for tests: objects in a Map behind the part of R2Bucket the documents use, with R2's check of
 * an upload against its SHA-256. Each call answers a new, empty bucket.
 */

/** One stored object: its bytes and what R2 keeps beside them. */
interface StoredObject {
  bytes: Uint8Array;
  httpMetadata: R2HTTPMetadata;
  customMetadata: Record<string, string>;
  uploaded: Date;
}

/** The object's description, as `head` answers it. */
function describeObject(key: string, stored: StoredObject) {
  return {
    key,
    size: stored.bytes.byteLength,
    uploaded: stored.uploaded,
    httpMetadata: stored.httpMetadata,
    customMetadata: stored.customMetadata,
  };
}

/** A bucket, and its objects for a test to read or change directly. */
export function testBucket() {
  const objects = new Map<string, StoredObject>();
  const bucket = {
    async put(key: string, value: Uint8Array, options: R2PutOptions = {}) {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', value));
      const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
      if (options.sha256 !== undefined && options.sha256 !== hex) {
        throw new Error('put: The SHA-256 checksum you specified did not match what we received.');
      }
      const stored: StoredObject = {
        bytes: value,
        httpMetadata: (options.httpMetadata ?? {}) as R2HTTPMetadata,
        customMetadata: options.customMetadata ?? {},
        uploaded: new Date(),
      };
      objects.set(key, stored);
      return describeObject(key, stored);
    },
    async head(key: string) {
      const stored = objects.get(key);
      return stored ? describeObject(key, stored) : null;
    },
    async get(key: string) {
      const stored = objects.get(key);
      return stored ? { ...describeObject(key, stored), body: new Blob([stored.bytes]).stream() } : null;
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
  // The documents use put, head, get and delete alone: what R2Bucket declares besides goes unused.
  return { bucket: bucket as unknown as R2Bucket, objects };
}
