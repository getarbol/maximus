/**
 * The pages service's own failures. A browser that is busy or down answers the standard, retryable
 * UPSTREAM_UNAVAILABLE.
 */
import { defineErrors } from '@arbol-ai/maximus';

export default defineErrors({
  hostNotAllowed: {
    code: 'HOST_NOT_ALLOWED',
    status: 422,
    message: 'The address must be an https URL at a host this service may open.',
  },
  pageNotLoaded: {
    code: 'PAGE_NOT_LOADED',
    status: 422,
    message:
      'The page did not load: it may not exist, be too slow, or need a host this service may not open.',
  },
});
