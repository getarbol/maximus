/**
 * The documents service's own failures, registered for every handler: `fail` and `failures` take these codes.
 */
import { defineErrors } from '@arbol-ai/maximus';

export default defineErrors({
  documentNotFound: { code: 'DOCUMENT_NOT_FOUND', status: 404, message: 'The document does not exist.' },
  documentNotAccepted: {
    code: 'DOCUMENT_NOT_ACCEPTED',
    status: 415,
    message: 'A document must be a PDF, PNG, JPEG or UTF-8 text file whose bytes match its content type.',
  },
});
