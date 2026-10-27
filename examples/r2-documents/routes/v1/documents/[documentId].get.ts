import { defineHandler, UuidSchema } from '@arbol-ai/maximus';

import { DocumentSchema } from '#src/documents.ts';

/** GET /api/v1/documents/{documentId}, also the MCP tool get_document: a document, without its bytes. */
export default defineHandler(
  async ({ input, documents, fail }) => {
    const document = await documents.describe(input.documentId);
    if (!document) {
      return fail('DOCUMENT_NOT_FOUND');
    }
    return document;
  },
  {
    description:
      "Describe one of the organization's documents: its name, type, size, SHA-256 and upload time.",
    input: { documentId: UuidSchema },
    output: DocumentSchema,
    failures: ['DOCUMENT_NOT_FOUND'],
    mcp: { name: 'get_document' },
  }
);
