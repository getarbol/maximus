import { defineHandler, t, UuidSchema } from '@arbol-ai/maximus';

import { NoteFields, NoteSchema } from '#src/notes.ts';

/** PATCH /api/v1/notes/{noteId}: the note, with its title, its body or both changed. */
export default defineHandler(
  async ({ input, notes, fail }) => {
    const { noteId, ...changes } = input;
    const note = await notes.update(noteId, changes);
    if (!note) {
      return fail('NOTE_NOT_FOUND');
    }
    return note;
  },
  {
    description: 'Change the title, the body or both of a note.',
    input: t.Object(
      { noteId: UuidSchema, title: t.Optional(NoteFields.title), body: t.Optional(NoteFields.body) },
      // Besides the path's id, at least one field to change.
      { additionalProperties: false, minProperties: 2 }
    ),
    output: NoteSchema,
    failures: ['NOTE_NOT_FOUND'],
  }
);
