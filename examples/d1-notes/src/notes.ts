/**
 * Notes in D1. Every statement names the verified organization, the leading column of the table's keys, so
 * one tenant never reads or changes another's notes; rows are read back through their schema; lists page by
 * keyset, newest first, with opaque cursors.
 */
import { Page, t, UuidSchema } from '@arbol-ai/maximus';
import type { PageQuery, Static } from '@arbol-ai/maximus';
import { readSchema } from '@arbol-ai/maximus/schemas';

/** A note as it is stored and answered. */
export const NoteSchema = t.Object(
  {
    noteId: UuidSchema,
    title: t.String({ minLength: 1, maxLength: 200 }),
    body: t.String({ maxLength: 10_000 }),
    createdAt: t.String({ format: 'date-time' }),
    updatedAt: t.String({ format: 'date-time' }),
  },
  { $id: 'Note', additionalProperties: false }
);
/** A note. */
export type Note = Static<typeof NoteSchema>;

/** One page of the organization's notes, newest first. */
export const NotePageSchema = Page(NoteSchema, { $id: 'NotePage' });
/** One page of notes. */
export type NotePage = Page<Note>;

/** What a caller writes in a note. */
export const NoteFields = {
  title: t.String({ minLength: 1, maxLength: 200 }),
  body: t.String({ maxLength: 10_000 }),
};

/** A row of the notes table. */
interface NoteRow {
  note_id: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
}

/** The columns a note is read from. */
const COLUMNS = 'note_id, title, body, created_at, updated_at';

/** A row as the note it stores, checked against the note's schema. */
function note(row: NoteRow): Note {
  return readSchema(NoteSchema, {
    noteId: row.note_id,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/** Where a page starts or ends in the keyset order: a note's creation time and id. */
type Position = readonly [createdAt: string, noteId: string];

/** A position as the opaque cursor callers send back. */
function encodeCursor(item: Note): string {
  return btoa(JSON.stringify([item.createdAt, item.noteId]))
    .replaceAll('+', '-')
    .replaceAll('/', '_');
}

/** The position a cursor names, or undefined when it is not a cursor this service issued. */
function decodeCursor(cursor: string): Position | undefined {
  try {
    const position: unknown = JSON.parse(atob(cursor.replaceAll('-', '+').replaceAll('_', '/')));
    if (
      Array.isArray(position) &&
      position.length === 2 &&
      typeof position[0] === 'string' &&
      !Number.isNaN(Date.parse(position[0])) &&
      typeof position[1] === 'string' &&
      /^[0-9a-f-]{36}$/.test(position[1])
    ) {
      return [position[0], position[1]];
    }
  } catch {
    // A cursor that is not base64 JSON is no cursor of ours.
  }
  return undefined;
}

/** `%`, `_` and the escape character itself, matched literally in a LIKE pattern. */
function literal(text: string): string {
  return text.replaceAll(/[\\%_]/g, (character) => `\\${character}`);
}

/** The organization's notes. */
export function noteStore(db: D1Database, organizationId: string) {
  /** The note, or undefined when the organization has none with this id. */
  const get = async (noteId: string): Promise<Note | undefined> => {
    const row = await db
      .prepare(`SELECT ${COLUMNS} FROM notes WHERE organization_id = ? AND note_id = ?`)
      .bind(organizationId, noteId)
      .first<NoteRow>();
    return row ? note(row) : undefined;
  };
  return {
    get,
    /**
     * One page of notes, newest first: from the start, or after (`forward`) or before (`backward`) the cursor.
     * Undefined when the cursor is not one this list issued.
     */
    async page(query: PageQuery): Promise<NotePage | undefined> {
      const position = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
      if (query.cursor !== undefined && !position) {
        return undefined;
      }
      const forward = query.direction === 'forward';
      // Forward walks the newest-first order; backward walks it the other way and turns the page around.
      const after = position ? `AND (created_at, note_id) ${forward ? '<' : '>'} (?, ?)` : '';
      const order = forward ? 'DESC' : 'ASC';
      const { results } = await db
        .prepare(
          `SELECT ${COLUMNS} FROM notes WHERE organization_id = ? ${after} ORDER BY created_at ${order}, note_id ${order} LIMIT ?`
        )
        .bind(organizationId, ...(position ?? []), query.limit + 1)
        .all<NoteRow>();
      const more = results.length > query.limit;
      const rows = results.slice(0, query.limit);
      const data = (forward ? rows : rows.toReversed()).map(note);
      const hasNextPage = forward ? more : position !== undefined;
      const hasPreviousPage = forward ? position !== undefined : more;
      const [first] = data;
      const last = data.at(-1);
      return {
        object: 'list',
        data,
        pageInfo: {
          hasNextPage,
          hasPreviousPage,
          nextCursor: hasNextPage && last ? encodeCursor(last) : null,
          previousCursor: hasPreviousPage && first ? encodeCursor(first) : null,
        },
      };
    },

    /** Stores a new note and answers it. */
    async create(fields: { title: string; body: string }): Promise<Note> {
      const now = new Date().toISOString();
      const created: Note = { noteId: crypto.randomUUID(), ...fields, createdAt: now, updatedAt: now };
      await db
        .prepare(
          'INSERT INTO notes (organization_id, note_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .bind(organizationId, created.noteId, created.title, created.body, now, now)
        .run();
      return created;
    },

    /** Changes the fields given and answers the note, or undefined when the organization has none. */
    async update(noteId: string, fields: { title?: string; body?: string }): Promise<Note | undefined> {
      const current = await get(noteId);
      if (!current) {
        return undefined;
      }
      const updated: Note = { ...current, ...fields, updatedAt: new Date().toISOString() };
      await db
        .prepare(
          'UPDATE notes SET title = ?, body = ?, updated_at = ? WHERE organization_id = ? AND note_id = ?'
        )
        .bind(updated.title, updated.body, updated.updatedAt, organizationId, noteId)
        .run();
      return updated;
    },

    /** Deletes the note; false when the organization had none with this id. */
    async remove(noteId: string): Promise<boolean> {
      const { meta } = await db
        .prepare('DELETE FROM notes WHERE organization_id = ? AND note_id = ?')
        .bind(organizationId, noteId)
        .run();
      return meta.changes > 0;
    },

    /** The newest notes whose title or body contains the text, at most `limit`. */
    async search(text: string, limit: number): Promise<Note[]> {
      const pattern = `%${literal(text)}%`;
      const { results } = await db
        .prepare(
          `SELECT ${COLUMNS} FROM notes WHERE organization_id = ? AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\') ORDER BY created_at DESC, note_id DESC LIMIT ?`
        )
        .bind(organizationId, pattern, pattern, limit)
        .all<NoteRow>();
      return results.map(note);
    },
  };
}

/** The notes of one organization. */
export type NoteStore = ReturnType<typeof noteStore>;
