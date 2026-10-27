/**
 * Documents in R2. Every key starts with the verified organization; R2 checks each upload against its SHA-256
 * before storing it; what an object's metadata says is read through the document's schema.
 */
import { t, UuidSchema } from '@arbol-ai/maximus';
import type { Static } from '@arbol-ai/maximus';
import { readSchema } from '@arbol-ai/maximus/schemas';

/** The largest document the service stores and answers, in bytes. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

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

/** A document and a stream of its bytes. */
export interface OpenedDocument {
  document: Document;
  body: ReadableStream;
}

/** The bytes' SHA-256, in lowercase hexadecimal. */
async function computeSha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The document an object's metadata describes, checked against the document's schema. */
function documentFromObject(documentId: string, object: R2Object): Document {
  return readSchema(DocumentSchema, {
    documentId,
    filename: object.customMetadata?.filename,
    contentType: object.httpMetadata?.contentType,
    byteLength: object.size,
    sha256: object.customMetadata?.sha256,
    uploadedAt: object.uploaded.toISOString(),
  });
}

/** The documents of one organization, stored under keys that start with its id. */
export function documentStore(bucket: R2Bucket, organizationId: string) {
  /** The key a document of the organization is stored under. */
  function documentKey(documentId: string): string {
    return `documents/${organizationId}/${documentId}`;
  }

  return {
    /** Stores the bytes as a new document of this name and type, and describes it. */
    async create(filename: string, contentType: string, bytes: Uint8Array<ArrayBuffer>): Promise<Document> {
      const documentId = crypto.randomUUID();
      const sha256 = await computeSha256(bytes);
      const stored = await bucket.put(documentKey(documentId), bytes, {
        sha256,
        httpMetadata: { contentType },
        customMetadata: { filename, sha256 },
      });
      return documentFromObject(documentId, stored);
    },

    /** The document, without its bytes, or undefined when the organization has none with this id. */
    async describe(documentId: string): Promise<Document | undefined> {
      const object = await bucket.head(documentKey(documentId));
      if (!object) {
        return undefined;
      }
      return documentFromObject(documentId, object);
    },

    /** The document and a stream of its bytes, or undefined when the organization has none with this id. */
    async open(documentId: string): Promise<OpenedDocument | undefined> {
      const object = await bucket.get(documentKey(documentId));
      if (!object) {
        return undefined;
      }
      return { document: documentFromObject(documentId, object), body: object.body };
    },

    /** Deletes the document, and answers whether the organization had one with this id. */
    async delete(documentId: string): Promise<boolean> {
      const object = await bucket.head(documentKey(documentId));
      if (!object) {
        return false;
      }
      await bucket.delete(documentKey(documentId));
      return true;
    },
  };
}
