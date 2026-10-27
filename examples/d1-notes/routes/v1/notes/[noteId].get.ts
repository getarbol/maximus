import { defineHandler, UuidSchema } from '@arbol-ai/maximus';

import { NoteSchema } from '#src/notes.ts';

/** GET /api/v1/notes/{noteId}, also the MCP tool get_note: one note of the caller's organization. */
export default defineHandler(
  async ({ input, notes, fail }) => {
    const note = await notes.find(input.noteId);
    if (!note) {
      return fail('NOTE_NOT_FOUND');
    }
    return note;
  },
  {
    description: 'Read one note of the organization by its id.',
    input: { noteId: UuidSchema },
    output: NoteSchema,
    failures: ['NOTE_NOT_FOUND'],
    mcp: { name: 'get_note' },
  }
);
