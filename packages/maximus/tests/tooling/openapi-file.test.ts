/**
 * `maximus openapi`: the document the project's Worker serves, written beside its sources, kept when it is
 * current, and checked without being written, a document that is not valid OpenAPI 3.1 failing the check.
 */
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, expect, test } from 'vite-plus/test';

import { assertValidOpenApi, writeOpenApi } from '../../src/tooling/internal/openapi-file.ts';
import { options, project, removeProjects } from './fixtures.ts';

/** Inside the workspace's node_modules, where the project resolves Vite and the Maximus build. */
const CACHE = fileURLToPath(new URL('../../../../node_modules/.cache/', import.meta.url));
/** The plugin's source, which the configuration imports. */
const PLUGIN = fileURLToPath(new URL('../../src/vite/project.ts', import.meta.url));
/** This package, which the project installs. */
const PACKAGE = fileURLToPath(new URL('../../', import.meta.url));

afterEach(removeProjects);

/** A route that reads one note by its id. */
const NOTE_ROUTE = [
  "import { defineHandler, t } from '@arbol-ai/maximus';",
  '',
  'export default defineHandler(({ input }) => ({ noteId: input.noteId }), {',
  "  description: 'Read one note of the organization.',",
  '  input: { noteId: t.String() },',
  '  output: { noteId: t.String() },',
  '});',
  '',
].join('\n');

test('writes the document the Worker serves, keeps it when it is current, and checks it without writing', async () => {
  const root = project(
    {
      'vite.config.ts': `import { maximusProject } from ${JSON.stringify(PLUGIN)};\nexport default { plugins: [maximusProject(() => (${JSON.stringify(options())}))] };\n`,
      'routes/v1/notes/[noteId].get.ts': NOTE_ROUTE,
    },
    CACHE
  );
  // The project's dependency on Maximus, as an install links it: its generated modules import the build.
  mkdirSync(join(root, 'node_modules/@arbol-ai'), { recursive: true });
  symlinkSync(PACKAGE, join(root, 'node_modules/@arbol-ai/maximus'));
  expect(await writeOpenApi(root)).toStrictEqual({
    file: join(root, 'openapi.json'),
    operations: 1,
    changed: true,
  });
  const text = readFileSync(join(root, 'openapi.json'), 'utf-8');
  const document = JSON.parse(text) as { servers: unknown; paths: Record<string, Record<string, unknown>> };
  // The document as the origin serves it, below the API's base path.
  expect(document.servers).toStrictEqual([{ url: 'https://tasks.example.test/api' }]);
  expect(document.paths['/v1/notes/{noteId}']?.get).toMatchObject({
    operationId: 'getNote',
    summary: 'Get a note',
    tags: ['Notes'],
  });
  expect(text.endsWith('}\n')).toBe(true);
  expect(await writeOpenApi(root)).toMatchObject({ changed: false });
  // A check reports a file that differs, and leaves it as it is.
  writeFileSync(join(root, 'openapi.json'), '{}\n');
  expect(await writeOpenApi(root, { check: true })).toMatchObject({ changed: true });
  expect(readFileSync(join(root, 'openapi.json'), 'utf-8')).toBe('{}\n');
  // Another file, in a folder that does not exist yet.
  expect(await writeOpenApi(root, { out: 'contracts/notes.json' })).toMatchObject({
    file: join(root, 'contracts/notes.json'),
    changed: true,
  });
}, 60_000);

test('writes the RPC document beside the HTTP one when a route is served over native RPC, and checks both', async () => {
  const configured = {
    ...options(),
    application: { ...options().application, rpc: { callers: ['orders'] } },
  };
  const root = project(
    {
      'vite.config.ts': `import { maximusProject } from ${JSON.stringify(PLUGIN)};\nexport default { plugins: [maximusProject(() => (${JSON.stringify(configured)}))] };\n`,
      'routes/v1/notes/[noteId].get.ts': NOTE_ROUTE.replace(
        '  output: { noteId: t.String() },',
        '  output: { noteId: t.String() },\n  rpc: true,'
      ),
    },
    CACHE
  );
  mkdirSync(join(root, 'node_modules/@arbol-ai'), { recursive: true });
  symlinkSync(PACKAGE, join(root, 'node_modules/@arbol-ai/maximus'));
  expect(await writeOpenApi(root)).toMatchObject({
    operations: 1,
    changed: true,
    rpc: { file: join(root, 'openapi.rpc.json'), operations: 1, changed: true },
  });
  const rpc = JSON.parse(readFileSync(join(root, 'openapi.rpc.json'), 'utf-8')) as { paths: object };
  expect(rpc.paths).toMatchObject({ '/rpc/getNote': { post: { 'x-rpc-callers': ['orders'] } } });
  // The RPC document's name follows the HTTP document's.
  expect(await writeOpenApi(root, { out: 'contracts/notes.json', check: true })).toMatchObject({
    rpc: { file: join(root, 'contracts/notes.rpc.json'), changed: true },
  });
  writeFileSync(join(root, 'openapi.rpc.json'), '{}\n');
  expect(await writeOpenApi(root, { check: true })).toMatchObject({ changed: false, rpc: { changed: true } });
}, 60_000);

test('refuses a document that is not valid OpenAPI 3.1, naming its file and its first problems', async () => {
  const valid = { openapi: '3.1.0', info: { title: 'Notes', version: '1' }, paths: {} };
  await expect(assertValidOpenApi('openapi.json', valid)).resolves.toBeUndefined();
  const listed = { get: { responses: { '200': { description: 'The notes.' } } } };
  for (const [document, problem] of [
    [{ ...valid, info: { version: '1' } }, "/info: must have required property 'title'"],
    [{ ...valid, paths: { 'v1/notes': listed } }, '/paths: Property v1/notes is not expected to be here'],
    [{ ...valid, openapi: '3.0.3' }, 'it declares OpenAPI 3.0'],
    [
      {
        ...valid,
        paths: {
          '/v1/notes': {
            get: {
              responses: {
                '200': {
                  description: 'The notes.',
                  content: { 'application/json': { schema: { $ref: '#/components/schemas/Missing' } } },
                },
              },
            },
          },
        },
      },
      "Can't resolve reference: #/components/schemas/Missing",
    ],
  ] as const) {
    await expect(assertValidOpenApi('openapi.rpc.json', document)).rejects.toThrow(
      new Error(`openapi.rpc.json is not valid OpenAPI 3.1: ${problem}.`)
    );
  }
  // The check reads a copy: the document it was given is the one written.
  const document = structuredClone(valid);
  await assertValidOpenApi('openapi.json', document);
  expect(document).toStrictEqual(valid);
});
