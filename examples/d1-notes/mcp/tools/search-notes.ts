import { defineTool, t } from '@arbol-ai/maximus';

import { NoteSchema } from '../../src/notes.ts';

/** The MCP tool search_notes: agents only, no HTTP route. */
export default defineTool(async ({ input, notes }) => ({ notes: await notes.search(input.text, 20) }), {
  description:
    "Find the organization's notes whose title or body contains a text, newest first, at most twenty.",
  effect: 'read',
  input: { text: t.String({ minLength: 2, maxLength: 100 }) },
  output: { notes: t.Array(NoteSchema) },
});
