/**
 * Tests of the notes service through its HTTP handler and the typed client, with an in-memory store.
 */
import { createHttpHandler } from '@arbol-ai/maximus';
import { createClient } from '@arbol-ai/maximus/client';
import { expect, it } from 'vitest';

import { app } from '../src/app';
import type { Env, NoteStore } from '../src/app';

/** A Map standing in for the KV namespace; the operations only need get, put and list. */
function memoryStore(): NoteStore {
  const values = new Map<string, string>();
  return {
    get: async (key) => values.get(key) ?? null,
    put: async (key, value) => {
      values.set(key, value);
    },
    list: async ({ prefix, limit }) => ({
      keys: [...values.keys()]
        .filter((name) => name.startsWith(prefix))
        .slice(0, limit)
        .map((name) => ({ name })),
    }),
  };
}

/** The development token, which the handler accepts only from localhost. */
const token = 'local-development-token-for-tests-only';
/** The Worker's bindings: an in-memory store and the development token. */
const env: Env = { NOTES: memoryStore(), DEVELOPMENT_TOKEN: token };
/** The application's HTTP handler, called directly. */
const handle = createHttpHandler(app);
/** The address `cf dev` serves on: a localhost origin, as the development token requires. */
const origin = 'http://localhost:5173';

/** The typed client, sending its requests straight to the handler instead of the network. */
const notes = createClient<typeof app>(origin, token, {
  response: 'data',
  fetch: async (input, init) => await handle(new Request(input, init), env),
});

/** The parts of a failure envelope these tests read. */
interface FailureBody {
  error: { code: string; data: { issues?: { path: string; message: string }[] } };
}

/** Sends a request with an authorization header straight to the handler, and reads the failure it answers. */
async function failure(path: string, init: RequestInit = {}, authorization = `Bearer ${token}`) {
  const headers = new Headers(init.headers);
  headers.set('authorization', authorization);
  const response = await handle(new Request(`${origin}${path}`, { ...init, headers }), env);
  return { response, body: (await response.json()) as FailureBody };
}

it('creates a note and reads it back in the same organization', async () => {
  const created = await notes.createNote({ text: 'Buy coffee' });
  expect(await notes.getNote({ noteId: created.noteId })).toEqual(created);
  expect((await notes.listNotes({})).notes).toEqual([created]);
});

it('refuses a request without a valid token before running the operation', async () => {
  const { response, body } = await failure('/v1/notes', {}, 'Bearer not-the-development-token');
  expect(response.status).toBe(401);
  expect(body.error.code).toBe('UNAUTHORIZED');
  expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
});

it('names the refused fields and never echoes their values', async () => {
  const { response, body } = await failure('/v1/notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '', organizationId: 'org_someoneelse12345' }),
  });
  expect(response.status).toBe(400);
  expect(body.error.data.issues?.map((issue) => issue.path)).toEqual(
    expect.arrayContaining(['/text', '/organizationId'])
  );
  expect(JSON.stringify(body)).not.toContain('org_someoneelse12345');
});

it('answers a declared domain failure with its catalog status', async () => {
  const { response, body } = await failure(`/v1/notes/${crypto.randomUUID()}`);
  expect(response.status).toBe(404);
  expect(body.error.code).toBe('NOTE_NOT_FOUND');
});
