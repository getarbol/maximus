import { defineHandler, UuidSchema } from '@arbol-ai/maximus';

/** DELETE /api/v1/notes/{noteId}: answers the empty object once the note is gone. */
export default defineHandler(
  async ({ input, notes, fail }) => {
    if (!(await notes.remove(input.noteId))) {
      return fail('NOTE_NOT_FOUND');
    }
  },
  {
    description: 'Delete a note of the organization.',
    input: { noteId: UuidSchema },
    failures: ['NOTE_NOT_FOUND'],
  }
);
