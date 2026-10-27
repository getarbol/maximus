import { defineTool, t } from '@arbol-ai/maximus';

import { NoteSchema } from '#src/notes.ts';

/** The most notes one search answers. */
const MAX_NOTES = 20;

/** The MCP tool search_notes, which no HTTP route serves: the newest notes that contain a text. */
export default defineTool(
  async ({ input, notes }) => {
    const matchingNotes = await notes.search(input.text, MAX_NOTES);
    return { notes: matchingNotes };
  },
  {
    description:
      "Find the organization's notes whose title or body contains a text, newest first, at most twenty.",
    effect: 'read',
    input: { text: t.String({ minLength: 2, maxLength: 100 }) },
    output: { notes: t.Array(NoteSchema) },
  }
);
