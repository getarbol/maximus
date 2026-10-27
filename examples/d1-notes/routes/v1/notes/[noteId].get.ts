import { defineHandler, UuidSchema } from '@arbol-ai/maximus';

import { NoteSchema } from '../../../src/notes.ts';

/** GET /api/v1/notes/{noteId}, also the MCP tool get_note. */
export default defineHandler(
  async ({ input, notes, fail }) => (await notes.get(input.noteId)) ?? fail('NOTE_NOT_FOUND'),
  {
    description: 'Read one note of the organization by its id.',
    input: { noteId: UuidSchema },
    output: NoteSchema,
    failures: ['NOTE_NOT_FOUND'],
    mcp: { name: 'get_note' },
  }
);
