/**
 * The tasks service's own failures. Registered for every handler: `fail` and `failures` take these codes.
 */
import { defineErrors } from '@arbol-ai/maximus';

export default defineErrors({
  taskNotFound: { code: 'TASK_NOT_FOUND', status: 404, message: 'The task does not exist.' },
});
