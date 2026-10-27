/**
 * Documents in R2. Every key starts with the verified organization; R2 checks each upload against its SHA-256
 * before storing it; what an object's metadata says is read through the document's schema.
 */
import { t, UuidSchema } from '@arbol-ai/maximus';
import type { Static } from '@arbol-ai/maximus';
import { readSchema } from '@arbol-ai/maximus/schemas';

/** A document's name: what a person would see, without control characters or path separators. */
export const FilenameSchema = t.String({
  minLength: 1,
  maxLength: 200,
  pattern: '^[^/\\\\\\u0000-\\u001f\\u007f]+$',
});

/** A document as the API describes it: everything but its bytes. */
export const DocumentSchema = t.Object(
  {
    documentId: UuidSchema,
    filename: FilenameSchema,
    contentType: t.String(),
    byteLength: t.Integer({ minimum: 1 }),
    sha256: t.String({ pattern: '^[0-9a-f]{64}$' }),
    uploadedAt: t.String({ format: 'date-time' }),
  },
  { $id: 'Document', additionalProperties: false }
);
/** A document. */
export type Document = Static<typeof DocumentSchema>;

/** A document's SHA-256, in lowercase hexadecimal. */
async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** What an object's metadata says of its document, checked against the document's schema. */
function describe(documentId: string, object: R2Object): Document {
  return readSchema(DocumentSchema, {
    documentId,
    filename: object.customMetadata?.filename,
    contentType: object.httpMetadata?.contentType,
    byteLength: object.size,
    sha256: object.customMetadata?.sha256,
    uploadedAt: object.uploaded.toISOString(),
  });
}

/** The organization's documents. */
export function documentStore(bucket: R2Bucket, organizationId: string) {
  const key = (documentId: string) => `documents/${organizationId}/${documentId}`;
  return {
    /** Stores the bytes as a new document of this name and type, and describes it. */
    async create(filename: string, contentType: string, bytes: Uint8Array<ArrayBuffer>): Promise<Document> {
      const documentId = crypto.randomUUID();
      const digest = await sha256(bytes);
      const stored = await bucket.put(key(documentId), bytes, {
        sha256: digest,
        httpMetadata: { contentType },
        customMetadata: { filename, sha256: digest },
      });
      return describe(documentId, stored);
    },
    /** The document, or undefined when the organization has none with this id. */
    async describe(documentId: string): Promise<Document | undefined> {
      const object = await bucket.head(key(documentId));
      return object ? describe(documentId, object) : undefined;
    },
    /** The document and a stream of its bytes, or undefined when the organization has none with this id. */
    async open(documentId: string): Promise<{ document: Document; body: ReadableStream } | undefined> {
      const object = await bucket.get(key(documentId));
      return object ? { document: describe(documentId, object), body: object.body } : undefined;
    },
    /** Deletes the document; false when the organization had none with this id. */
    async remove(documentId: string): Promise<boolean> {
      if (!(await bucket.head(key(documentId)))) {
        return false;
      }
      await bucket.delete(key(documentId));
      return true;
    },
  };
}
