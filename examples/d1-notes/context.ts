/**
 * What every handler receives besides its input: the notes of the caller's organization.
 */
import { defineContext } from '@arbol-ai/maximus';

import { noteStore } from './src/notes.ts';

export default defineContext(({ env, principal }) => ({
  notes: noteStore(env.NOTES_DB, principal.organizationId),
}));
