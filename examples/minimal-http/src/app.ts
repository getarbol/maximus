/**
 * The notes application: three HTTP operations on a Workers KV namespace, with a domain failure and stored
 * values read through their schema.
 */
import { defineErrors, err, maximus, ok, t, UuidSchema } from '@arbol-ai/maximus';
import { readSchema } from '@arbol-ai/maximus/schemas';

import { tokens } from './tokens';

/** The part of a Workers KV namespace this service uses. */
export interface NoteStore {
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string) => Promise<void>;
  list: (options: { prefix: string; limit: number }) => Promise<{ keys: { name: string }[] }>;
}

/** The bindings declared in cloudflare.config.ts, plus the local-only development token. */
export interface Env {
  NOTES: NoteStore;
  DEVELOPMENT_TOKEN?: string;
}

/** A note as it is stored and answered. */
const NoteSchema = t.Object(
  {
    noteId: UuidSchema,
    text: t.String({ minLength: 1, maxLength: 2000 }),
    createdAt: t.String({ format: 'date-time' }),
  },
  { additionalProperties: false }
);

/** The standard failures plus the notes service's own. */
const errors = defineErrors({
  noteNotFound: { code: 'NOTE_NOT_FOUND', status: 404, message: 'The note does not exist.' },
});

/** Every key starts with the verified organization, so one tenant never reads another's notes. */
function noteKey(organizationId: string, noteId: string): string {
  return `notes/${organizationId}/${noteId}`;
}

/** Stored values are untrusted until read through their schema. */
async function readNote(store: NoteStore, key: string) {
  const stored = await store.get(key);
  return stored === null ? null : readSchema(NoteSchema, JSON.parse(stored));
}

/** The notes application: create, read and list notes over HTTP. */
export const app = maximus<Env>({
  name: 'example-notes',
  namespace: 'notes',
  title: 'Notes',
  version: '1.0.0',
  origin: 'https://notes.example.com',
  tokens,
  errors,
  rpc: { callers: [] },
})
  .operation(
    'createNote',
    {
      scope: 'notes:notes:write',
      effect: 'write',
      title: 'Create a note',
      description: "Store a note for the caller's organization.",
      input: t.Object({ text: NoteSchema.properties.text }, { additionalProperties: false }),
      output: NoteSchema,
      http: { method: 'POST', path: '/v1/notes', successStatus: 201 },
    },
    async ({ env, principal }, input) => {
      const note = { noteId: crypto.randomUUID(), text: input.text, createdAt: new Date().toISOString() };
      await env.NOTES.put(noteKey(principal.organizationId, note.noteId), JSON.stringify(note));
      return ok(note);
    }
  )
  .operation(
    'getNote',
    {
      scope: ['notes:notes:read', 'notes:notes:write'],
      effect: 'read',
      title: 'Get a note',
      description: 'Read one note by its identifier.',
      input: t.Object({ noteId: UuidSchema }, { additionalProperties: false }),
      output: NoteSchema,
      http: { method: 'GET', path: '/v1/notes/{noteId}' },
    },
    async ({ env, principal }, input) => {
      const note = await readNote(env.NOTES, noteKey(principal.organizationId, input.noteId));
      return note ? ok(note) : err(errors.noteNotFound.create());
    }
  )
  .operation(
    'listNotes',
    {
      scope: ['notes:notes:read', 'notes:notes:write'],
      effect: 'read',
      title: 'List notes',
      description: "List up to 50 of the organization's notes.",
      input: t.Object({}, { additionalProperties: false }),
      output: t.Object({ notes: t.Array(NoteSchema) }, { additionalProperties: false }),
      http: { method: 'GET', path: '/v1/notes' },
    },
    async ({ env, principal }) => {
      const { keys } = await env.NOTES.list({ prefix: noteKey(principal.organizationId, ''), limit: 50 });
      const notes = await Promise.all(keys.map(({ name }) => readNote(env.NOTES, name)));
      return ok({ notes: notes.filter((note) => note !== null) });
    }
  )
  .build();
