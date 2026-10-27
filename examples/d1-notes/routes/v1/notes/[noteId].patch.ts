import { defineHandler, t, UuidSchema } from '@arbol-ai/maximus';

import { NoteFields, NoteSchema } from '../../../src/notes.ts';

/** PATCH /api/v1/notes/{noteId}: changes the title, the body or both. */
export default defineHandler(
  async ({ input: { noteId, ...fields }, notes, fail }) =>
    (await notes.update(noteId, fields)) ?? fail('NOTE_NOT_FOUND'),
  {
    description: 'Change the title, the body or both of a note.',
    input: t.Object(
      { noteId: UuidSchema, title: t.Optional(NoteFields.title), body: t.Optional(NoteFields.body) },
      { additionalProperties: false, minProperties: 2 }
    ),
    output: NoteSchema,
    failures: ['NOTE_NOT_FOUND'],
  }
);
