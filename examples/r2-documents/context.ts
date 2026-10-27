/**
 * What every handler receives besides its input: the caller's organization's documents.
 */
import { defineContext } from '@arbol-ai/maximus';

import { documentStore } from './src/documents.ts';

export default defineContext(({ env, principal }) => ({
  documents: documentStore(env.DOCUMENTS, principal.organizationId),
}));
