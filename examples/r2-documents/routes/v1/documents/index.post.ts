import { defineHandler, t } from '@arbol-ai/maximus';

import { DocumentSchema, FilenameSchema } from '../../../src/documents.ts';
import { acceptedFormat } from '../../../src/formats.ts';

/** The largest document the service accepts, in bytes. */
const MAX_DOCUMENT = 10 * 1024 * 1024;

/**
 * POST /api/v1/documents?filename=…: the request's bytes, as a new document of its `content-type`, answered
 * with 201 Created. The bytes are read within the limit, then must match the type before anything is stored.
 */
export default defineHandler(
  async ({ input, body, documents, fail }) => {
    const bytes = await body.read();
    if (!bytes.ok) {
      return bytes.error;
    }
    const format = acceptedFormat(input.contentType, bytes.value);
    if (!format) {
      return fail('DOCUMENT_NOT_ACCEPTED');
    }
    return documents.create(input.filename, format, bytes.value);
  },
  {
    description: 'Upload a document: a PDF, PNG, JPEG or UTF-8 text file of at most 10 MiB.',
    input: {
      filename: FilenameSchema,
      contentType: t.String({ maxLength: 255, description: 'The content-type header.' }),
    },
    output: DocumentSchema,
    failures: ['DOCUMENT_NOT_ACCEPTED'],
    http: { body: 'bytes', headers: { contentType: 'content-type' }, successStatus: 201 },
    maxBodyBytes: MAX_DOCUMENT,
  }
);
