import { AttachmentOutputSchema, defineHandler, UuidSchema } from '@arbol-ai/maximus';

/**
 * GET /api/v1/documents/{documentId}/content: the document's bytes as an attachment, streamed from R2 with
 * the exact length its metadata states.
 */
export default defineHandler(
  async ({ input, documents, fail }) => {
    const opened = await documents.open(input.documentId);
    if (!opened) {
      return fail('DOCUMENT_NOT_FOUND');
    }
    const { document, body } = opened;
    return {
      body,
      contentType: document.contentType,
      filename: document.filename,
      byteLength: document.byteLength,
    };
  },
  {
    description: 'Download a document of the organization.',
    input: { documentId: UuidSchema },
    output: AttachmentOutputSchema,
    failures: ['DOCUMENT_NOT_FOUND'],
    http: { response: 'attachment' },
    maxOutputBytes: 10 * 1024 * 1024,
  }
);
