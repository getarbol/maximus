import { defineHandler } from '@arbol-ai/maximus';

import { NoteFields, NoteSchema } from '#src/notes.ts';

/** POST /api/v1/notes: a new note, answered with 201 Created. */
export default defineHandler(({ input, notes }) => notes.create(input), {
  description: 'Write a new note for the organization.',
  input: NoteFields,
  output: NoteSchema,
  http: { successStatus: 201 },
});
