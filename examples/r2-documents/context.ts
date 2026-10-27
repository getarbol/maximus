/**
 * What every handler receives besides its input: the documents of the caller's organization.
 */
import { defineContext } from '@arbol-ai/maximus';

import { documentStore } from '#src/documents.ts';

export default defineContext(({ env, principal }) => ({
  documents: documentStore(env.DOCUMENTS, principal.organizationId),
}));
