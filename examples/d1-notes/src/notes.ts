/**
 * Notes in D1. Every statement names the verified organization, the leading column of the table's keys, so
 * one tenant never reads or changes another's notes; rows are read back through their schema; lists page by
 * keyset, newest first, with opaque cursors.
 */
import { Page, t, UuidSchema } from '@arbol-ai/maximus';
import type { PageQuery, Static } from '@arbol-ai/maximus';
import { readSchema } from '@arbol-ai/maximus/schemas';

/** What a caller writes in a note: its title and its body. */
export const NoteFields = {
  title: t.String({ minLength: 1, maxLength: 200 }),
  body: t.String({ maxLength: 10_000 }),
};

/** A note as it is stored and answered. */
export const NoteSchema = t.Object(
  {
    noteId: UuidSchema,
    title: NoteFields.title,
    body: NoteFields.body,
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

/** What a change to a note sets: its title, its body or both. */
export type NoteChanges = Partial<Pick<Note, 'title' | 'body'>>;

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

/** The note a row stores, checked against the note's schema. */
function noteFromRow(row: NoteRow): Note {
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

/** The opaque cursor a caller sends back to continue a list from this note. */
function encodeCursor(note: Note): string {
  const position: Position = [note.createdAt, note.noteId];
  return btoa(JSON.stringify(position)).replaceAll('+', '-').replaceAll('/', '_');
}

/** Whether a decoded cursor holds a position: a creation time and a note id. */
function isPosition(decoded: unknown): decoded is Position {
  if (!Array.isArray(decoded) || decoded.length !== 2) {
    return false;
  }
  const [createdAt, noteId]: unknown[] = decoded;
  const isCreationTime = typeof createdAt === 'string' && !Number.isNaN(Date.parse(createdAt));
  const isNoteId = typeof noteId === 'string' && /^[0-9a-f-]{36}$/.test(noteId);
  return isCreationTime && isNoteId;
}

/** The position a cursor names, or undefined when it is not a cursor this service issued. */
function decodeCursor(cursor: string): Position | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(atob(cursor.replaceAll('-', '+').replaceAll('_', '/')));
  } catch {
    // A cursor that is not base64 JSON is no cursor of ours.
    return undefined;
  }
  if (!isPosition(decoded)) {
    return undefined;
  }
  return decoded;
}

/** The text with `%`, `_` and the escape character escaped, so a LIKE pattern matches it literally. */
function escapeLikePattern(text: string): string {
  return text.replaceAll(/[\\%_]/g, (character) => `\\${character}`);
}

/** Whether a list goes on after a page, and before it. */
interface PageNeighbors {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/** A page of notes in newest-first order, with a cursor for each direction the list goes on in. */
function notePage(notes: Note[], neighbors: PageNeighbors): NotePage {
  const first = notes.at(0);
  const last = notes.at(-1);
  return {
    object: 'list',
    data: notes,
    pageInfo: {
      hasNextPage: neighbors.hasNextPage,
      hasPreviousPage: neighbors.hasPreviousPage,
      nextCursor: neighbors.hasNextPage && last ? encodeCursor(last) : null,
      previousCursor: neighbors.hasPreviousPage && first ? encodeCursor(first) : null,
    },
  };
}

/** The notes of one organization, which every statement binds. */
export function noteStore(database: D1Database, organizationId: string) {
  /** The note with this id, or undefined when the organization has none. */
  async function find(noteId: string): Promise<Note | undefined> {
    const row = await database
      .prepare(`SELECT ${COLUMNS} FROM notes WHERE organization_id = ? AND note_id = ?`)
      .bind(organizationId, noteId)
      .first<NoteRow>();
    if (!row) {
      return undefined;
    }
    return noteFromRow(row);
  }

  return {
    find,

    /**
     * One page of notes, newest first: from the start, or after (`forward`) or before (`backward`) the
     * cursor. Undefined when the cursor is not one this list issued.
     */
    async list(query: PageQuery): Promise<NotePage | undefined> {
      let position: Position | undefined;
      if (query.cursor !== undefined) {
        position = decodeCursor(query.cursor);
        if (!position) {
          return undefined;
        }
      }
      const isForward = query.direction === 'forward';
      // Forward walks the newest-first order; backward walks it the other way and turns the page around.
      const after = position ? `AND (created_at, note_id) ${isForward ? '<' : '>'} (?, ?)` : '';
      const order = isForward ? 'DESC' : 'ASC';
      // One row past the page tells whether the list goes on in this direction.
      const { results } = await database
        .prepare(
          `SELECT ${COLUMNS} FROM notes WHERE organization_id = ? ${after} ORDER BY created_at ${order}, note_id ${order} LIMIT ?`
        )
        .bind(organizationId, ...(position ?? []), query.limit + 1)
        .all<NoteRow>();
      const hasMore = results.length > query.limit;
      const rows = results.slice(0, query.limit);
      const newestFirst = isForward ? rows : rows.toReversed();
      const hasCursor = position !== undefined;
      return notePage(newestFirst.map(noteFromRow), {
        hasNextPage: isForward ? hasMore : hasCursor,
        hasPreviousPage: isForward ? hasCursor : hasMore,
      });
    },

    /** Stores a new note and answers it. */
    async create(fields: Pick<Note, 'title' | 'body'>): Promise<Note> {
      const now = new Date().toISOString();
      const note: Note = { noteId: crypto.randomUUID(), ...fields, createdAt: now, updatedAt: now };
      await database
        .prepare(
          'INSERT INTO notes (organization_id, note_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .bind(organizationId, note.noteId, note.title, note.body, now, now)
        .run();
      return note;
    },

    /** Changes the given fields and answers the note, or undefined when the organization has none. */
    async update(noteId: string, changes: NoteChanges): Promise<Note | undefined> {
      const note = await find(noteId);
      if (!note) {
        return undefined;
      }
      const updated: Note = { ...note, ...changes, updatedAt: new Date().toISOString() };
      await database
        .prepare(
          'UPDATE notes SET title = ?, body = ?, updated_at = ? WHERE organization_id = ? AND note_id = ?'
        )
        .bind(updated.title, updated.body, updated.updatedAt, organizationId, noteId)
        .run();
      return updated;
    },

    /** Deletes the note, and answers whether the organization had one with this id. */
    async delete(noteId: string): Promise<boolean> {
      const { meta } = await database
        .prepare('DELETE FROM notes WHERE organization_id = ? AND note_id = ?')
        .bind(organizationId, noteId)
        .run();
      return meta.changes > 0;
    },

    /** The newest notes whose title or body contains the text, at most `maxNotes` of them. */
    async search(text: string, maxNotes: number): Promise<Note[]> {
      const pattern = `%${escapeLikePattern(text)}%`;
      const { results } = await database
        .prepare(
          `SELECT ${COLUMNS} FROM notes WHERE organization_id = ? AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\') ORDER BY created_at DESC, note_id DESC LIMIT ?`
        )
        .bind(organizationId, pattern, pattern, maxNotes)
        .all<NoteRow>();
      return results.map(noteFromRow);
    },
  };
}

/** The notes of one organization. */
export type NoteStore = ReturnType<typeof noteStore>;
