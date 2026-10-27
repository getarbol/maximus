import { defineHandler, UuidSchema } from '@arbol-ai/maximus';

/** DELETE /api/v1/documents/{documentId}: answers the empty object once the document is gone. */
export default defineHandler(
  async ({ input, documents, fail }) => {
    if (!(await documents.remove(input.documentId))) {
      return fail('DOCUMENT_NOT_FOUND');
    }
  },
  {
    description: 'Delete one of the organization’s documents.',
    input: { documentId: UuidSchema },
    failures: ['DOCUMENT_NOT_FOUND'],
  }
);
