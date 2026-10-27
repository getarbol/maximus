/**
 * The notes service's own failures, registered for every handler: `fail` and `failures` take these codes.
 */
import { defineErrors } from '@arbol-ai/maximus';

export default defineErrors({
  noteNotFound: { code: 'NOTE_NOT_FOUND', status: 404, message: 'The note does not exist.' },
  invalidCursor: {
    code: 'INVALID_CURSOR',
    status: 400,
    message: 'The cursor does not belong to this list; list again from the first page.',
  },
});
