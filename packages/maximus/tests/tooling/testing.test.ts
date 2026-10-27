/**
 * verifyContract, the smoke test of `@arbol-ai/maximus/testing`: it reads a service's OpenAPI document as JSON
 * and YAML below its origin, answers the paths and operations it lists, and refuses a document that is
 * unavailable or whose two forms differ.
 */
import { expect, test } from 'vite-plus/test';
import { stringify } from 'yaml';

import { createHttpHandler, defineErrors, maximus, ok, t } from '../../src/index.ts';
import { verifyContract } from '../../src/tooling/testing.ts';

const note = t.Object({ noteId: t.String(), text: t.String() }, { additionalProperties: false });
const app = maximus<object>({
  name: 'notes',
  namespace: 'notes',
  title: 'Notes',
  version: '1',
  origin: 'https://notes.example.test',
  tokens: { issuer: 'https://issuer.example.test/', audience: 'https://notes.example.test' },
  errors: defineErrors({}),
  rpc: { callers: [] },
  telemetry: { enabled: false },
})
  .operation(
    'listNotes',
    {
      scope: 'notes:notes:read',
      title: 'List notes',
      description: 'List the notes.',
      effect: 'read',
      input: t.Object({}, { additionalProperties: false }),
      output: t.Object({ notes: t.Array(note) }, { additionalProperties: false }),
      http: { method: 'GET', path: '/v1/notes' },
    },
    async () => ok({ notes: [] })
  )
  .operation(
    'createNote',
    {
      scope: 'notes:notes:write',
      title: 'Create a note',
      description: 'Create a note.',
      effect: 'write',
      input: t.Object({ text: t.String() }, { additionalProperties: false }),
      output: note,
      http: { method: 'POST', path: '/v1/notes' },
    },
    async (_context, input) => ok({ noteId: 'note-1', text: input.text })
  )
  .operation(
    'getNote',
    {
      scope: 'notes:notes:read',
      title: 'Get a note',
      description: 'Get one note.',
      effect: 'read',
      input: t.Object({ noteId: t.String() }, { additionalProperties: false }),
      output: note,
      http: { method: 'GET', path: '/v1/notes/{noteId}' },
    },
    async (_context, input) => ok({ noteId: input.noteId, text: '' })
  )
  .build();

/** The service as verifyContract fetches it, recording each URL it requests. */
function service(basePath?: string) {
  const handle = createHttpHandler(app, basePath ? { basePath } : {});
  const requested: string[] = [];
  const fetch = async (request: Request) => {
    requested.push(request.url);
    return handle(request, {});
  };
  return { fetch, requested };
}

test('answers the paths and operations a running service documents, read below its origin', async () => {
  const { fetch, requested } = service('/api');
  expect(await verifyContract(fetch, 'https://notes.example.test/api')).toEqual({
    paths: ['/v1/notes', '/v1/notes/{noteId}'],
    operations: ['listNotes', 'createNote', 'getNote'],
  });
  expect(requested).toEqual([
    'https://notes.example.test/api/openapi.json',
    'https://notes.example.test/api/openapi.yaml',
  ]);
});

test('refuses a service that does not serve its document as JSON or as YAML', async () => {
  const { fetch } = service();
  const without = (suffix: string) => async (request: Request) =>
    request.url.endsWith(suffix) ? new Response('missing', { status: 404 }) : fetch(request);
  for (const suffix of ['/openapi.json', '/openapi.yaml']) {
    await expect(verifyContract(without(suffix), 'https://notes.example.test'), suffix).rejects.toThrow(
      'OpenAPI is unavailable.'
    );
  }
});

test('refuses a service whose YAML document is not its JSON document', async () => {
  const { fetch } = service();
  const document = (await (await fetch(new Request('https://notes.example.test/openapi.json'))).json()) as {
    info: Record<string, unknown>;
  };
  const stale = stringify({ ...document, info: { ...document.info, version: '0' } });
  const drifted = async (request: Request) =>
    request.url.endsWith('/openapi.yaml') ? new Response(stale) : fetch(request);
  await expect(verifyContract(drifted, 'https://notes.example.test')).rejects.toThrow(
    'OpenAPI JSON/YAML differ.'
  );
});
