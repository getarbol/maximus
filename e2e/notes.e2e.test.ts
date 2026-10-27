/**
 * The D1 notes example running on its migrated database: a note written, found over MCP and deleted.
 */
import { describe, expect, it } from 'vite-plus/test';

import { call, data, mcp, required, service } from './services.ts';
import { publicSurface } from './surface.ts';

publicSurface('notes', { method: 'GET', path: '/v1/notes', mcp: true });

describe.runIf(service('notes')?.token)('notes: signed in', () => {
  it('writes a note, finds it by a word of it over MCP, and deletes it', async () => {
    const worker = required('notes');
    const word = `e2e${crypto.randomUUID().slice(0, 8)}`;
    const note = await data<{ noteId: string }>(
      call(worker, '/api/v1/notes', {
        method: 'POST',
        json: { title: `Follow-up ${word}`, body: 'Call back.' },
      })
    );
    expect(await data(call(worker, `/api/v1/notes/${note.noteId}`))).toMatchObject({
      title: `Follow-up ${word}`,
    });
    expect(
      await mcp(worker, 'tools/call', { name: 'search_notes', arguments: { text: word } })
    ).toMatchObject({
      structuredContent: { notes: [{ noteId: note.noteId }] },
    });
    expect((await call(worker, `/api/v1/notes/${note.noteId}`, { method: 'DELETE' })).status).toBe(200);
  });
});
