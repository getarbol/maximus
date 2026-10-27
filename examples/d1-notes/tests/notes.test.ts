/**
 * The notes service in Node, through the API the Worker serves, over a D1 stand-in with the real migrations:
 * writing, reading, changing and deleting a note; pages and their cursors; refusals; MCP; and, through the
 * store itself, that one organization never reaches another's notes and that search reads text literally.
 */
import { beforeEach, expect, it } from 'vite-plus/test';

import { handler } from '#maximus/http';

import { noteStore } from '../src/notes.ts';
import type { Note, NotePage } from '../src/notes.ts';
import { testDatabase } from './d1.ts';

/** The development token `vp test` accepts from localhost, as a developer holding every scope. */
const token = 'test-development-token-for-local-tests';
let env: Env;

beforeEach(() => {
  env = { DEVELOPMENT_TOKEN: token, NOTES_DB: testDatabase() } as Env;
});

/** Calls the API with the development token, sending `body` as JSON when there is one. */
async function call(method: string, path: string, body?: unknown) {
  const response = await handler(
    new Request(`http://localhost/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env
  );
  return { status: response.status, body: (await response.json()) as { data: unknown; error: unknown } };
}

/** Writes a note and answers it. */
async function write(title: string, body = ''): Promise<Note> {
  return (await call('POST', '/v1/notes', { title, body })).body.data as Note;
}

it('writes a note, reads it, changes it and deletes it', async () => {
  const created = await call('POST', '/v1/notes', { title: 'Follow-up', body: 'Call back on Monday.' });
  expect(created.status).toBe(201);
  const note = created.body.data as Note;
  expect(note).toMatchObject({ title: 'Follow-up', body: 'Call back on Monday.' });
  expect((await call('GET', `/v1/notes/${note.noteId}`)).body.data).toEqual(note);
  const changed = await call('PATCH', `/v1/notes/${note.noteId}`, { body: 'Called; all good.' });
  expect(changed.body.data).toMatchObject({ title: 'Follow-up', body: 'Called; all good.' });
  expect((await call('DELETE', `/v1/notes/${note.noteId}`)).body.data).toEqual({});
  expect(await call('GET', `/v1/notes/${note.noteId}`)).toMatchObject({
    status: 404,
    body: { error: { code: 'NOTE_NOT_FOUND' } },
  });
  expect((await call('DELETE', `/v1/notes/${note.noteId}`)).status).toBe(404);
});

it('pages newest first, forward and back, with the cursors each page gives', async () => {
  const written = [];
  for (const title of ['one', 'two', 'three', 'four', 'five']) {
    written.push(await write(title));
  }
  const newest = written.toReversed().map(({ title }) => title);
  const page = async (query: string) => (await call('GET', `/v1/notes${query}`)).body.data as NotePage;
  const first = await page('?limit=2');
  expect(first.data.map(({ title }) => title)).toEqual(newest.slice(0, 2));
  expect(first.pageInfo).toMatchObject({ hasNextPage: true, hasPreviousPage: false, previousCursor: null });
  const second = await page(`?limit=2&cursor=${first.pageInfo.nextCursor}`);
  expect(second.data.map(({ title }) => title)).toEqual(newest.slice(2, 4));
  const last = await page(`?limit=2&cursor=${second.pageInfo.nextCursor}`);
  expect(last.data.map(({ title }) => title)).toEqual(newest.slice(4));
  expect(last.pageInfo).toMatchObject({ hasNextPage: false, nextCursor: null, hasPreviousPage: true });
  const back = await page(`?limit=2&direction=backward&cursor=${last.pageInfo.previousCursor}`);
  expect(back.data.map(({ title }) => title)).toEqual(newest.slice(2, 4));
  expect((await page('')).data).toHaveLength(5);
});

it('refuses a cursor it never issued, an empty title, an empty change and fields it does not know', async () => {
  expect(await call('GET', '/v1/notes?cursor=not-a-cursor')).toMatchObject({
    status: 400,
    body: { error: { code: 'INVALID_CURSOR' } },
  });
  for (const [method, path, body] of [
    ['POST', '/v1/notes', { title: '', body: '' }],
    ['POST', '/v1/notes', { title: 'x', body: '', pinned: true }],
    ['PATCH', `/v1/notes/${crypto.randomUUID()}`, {}],
    ['GET', '/v1/notes/not-a-uuid', undefined],
    ['GET', '/v1/notes?limit=500', undefined],
  ] as const) {
    expect((await call(method, path, body)).status, `${method} ${path}`).toBe(400);
  }
});

it('serves list_notes, get_note and search_notes over MCP', async () => {
  await write('Allergy: penicillin');
  const rpc = async (method: string, params: object) => {
    const response = await handler(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
      env
    );
    const text = await response.text();
    return (JSON.parse(/data: (\{[^\n]*)/u.exec(text)?.[1] ?? text) as { result: Record<string, unknown> })
      .result;
  };
  const listed = (await rpc('tools/list', {})).tools as { name: string }[];
  expect(listed.map(({ name }) => name).toSorted()).toEqual(['get_note', 'list_notes', 'search_notes']);
  expect(await rpc('tools/call', { name: 'search_notes', arguments: { text: 'penicillin' } })).toMatchObject({
    structuredContent: { notes: [{ title: 'Allergy: penicillin' }] },
  });
});

it('keeps each organization to its own notes, and searches text literally', async () => {
  const database = testDatabase();
  const clinic = noteStore(database, 'org_clinic');
  const lab = noteStore(database, 'org_lab');
  const note = await clinic.create({ title: '100% done', body: 'with_underscore' });
  await clinic.create({ title: '100 done', body: 'withXunderscore' });
  expect(await lab.get(note.noteId)).toBeUndefined();
  expect(await lab.update(note.noteId, { title: 'taken' })).toBeUndefined();
  expect(await lab.remove(note.noteId)).toBe(false);
  expect(await lab.search('done', 20)).toEqual([]);
  // `%` and `_` match themselves, not any text.
  expect((await clinic.search('0%', 20)).map(({ title }) => title)).toEqual(['100% done']);
  expect((await clinic.search('h_u', 20)).map(({ body }) => body)).toEqual(['with_underscore']);
  expect(await clinic.get(note.noteId)).toEqual(note);
});

it('refuses a caller without a token', async () => {
  const response = await handler(new Request('http://localhost/api/v1/notes'), env);
  expect(response.status).toBe(401);
});
