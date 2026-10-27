/**
 * What project discovery refuses at its boundaries, beside the generator's main matrix: root modules and
 * generated output that are symlinks or not ordinary files, runtime imports of generated modules that would
 * form a cycle for each kind of module, Workers-only imports in configuration, modules that do not parse or
 * export other names, cron schedules that are not literal constants, and pages, events and Durable Objects
 * whose names collide.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, expect, test } from 'vite-plus/test';

import { prepareProject } from '../../src/tooling/internal/prepare-project.ts';

const directories: string[] = [];

/** A new temporary directory, removed after the test. */
function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), 'maximus-boundaries-'));
  directories.push(directory);
  return directory;
}

/** Creates or replaces files of a project. */
function write(root: string, files: Record<string, string>): void {
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), contents);
  }
}

/** A project of the 7.3 layout, configured by its src/ entries, with these files. */
function project(files: Record<string, string> = {}): string {
  const root = temporary();
  write(root, {
    'src/application.ts': 'export const base = {};',
    'src/worker.ts': 'export const options = {};',
    ...files,
  });
  return root;
}

/** A generated module as text. */
function generated(root: string, name: string): string {
  return readFileSync(join(root, '.maximus', name), 'utf-8');
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a root module or the generated directory that is a symlink is refused, and nothing is written through it', () => {
  const linkedErrors = project({ 'shared/errors.ts': 'export default {};' });
  symlinkSync(join(linkedErrors, 'shared/errors.ts'), join(linkedErrors, 'errors.ts'));
  expect(() => prepareProject(linkedErrors)).toThrow('The errors module cannot be a symlink.');
  const linkedConfig = project({ 'shared/config.ts': 'export default {};' });
  symlinkSync(join(linkedConfig, 'shared/config.ts'), join(linkedConfig, 'maximus.config.ts'));
  expect(() => prepareProject(linkedConfig)).toThrow('The maximus.config module cannot be a symlink.');
  const outside = temporary();
  const linkedOutput = project({ 'routes/v1/notes.ts': 'export const GET = {};' });
  symlinkSync(outside, join(linkedOutput, '.maximus'));
  expect(() => prepareProject(linkedOutput)).toThrow('The generated .maximus directory cannot be a symlink.');
  expect(readdirSync(outside)).toEqual([]);
});

test('a generated file that is a symlink or a directory is refused before any output is replaced', () => {
  const root = project({ 'routes/v1/notes.ts': 'export const GET = {};' });
  prepareProject(root);
  const app = generated(root, 'app.ts');
  const outside = temporary();
  writeFileSync(join(outside, 'worker.ts'), 'keep');
  rmSync(join(root, '.maximus/worker.ts'));
  symlinkSync(join(outside, 'worker.ts'), join(root, '.maximus/worker.ts'));
  // The new route changes app.ts, which must not be written while worker.ts is refused.
  write(root, { 'routes/v1/tags.ts': 'export const GET = {};' });
  expect(() => prepareProject(root)).toThrow('Generated files must be ordinary files: worker.ts');
  expect(generated(root, 'app.ts')).toBe(app);
  expect(readFileSync(join(outside, 'worker.ts'), 'utf-8')).toBe('keep');
  rmSync(join(root, '.maximus/worker.ts'));
  mkdirSync(join(root, '.maximus/worker.ts'));
  expect(() => prepareProject(root)).toThrow('Generated files must be ordinary files: worker.ts');
  expect(generated(root, 'app.ts')).toBe(app);
});

test('a route may not import the generated app, Worker or entry at runtime, in any import or export form', () => {
  for (const [contents, source] of [
    ["import { app } from '#maximus/app';\nexport const GET = app;", '#maximus/app'],
    ["import '../../.maximus/worker.ts';\nexport const GET = {};", '../../.maximus/worker.ts'],
    ["export { GET } from '#maximus/entry';", '#maximus/entry'],
  ] as const) {
    const root = project({ 'routes/v1/notes.ts': contents });
    expect(() => prepareProject(root), contents).toThrow(
      `Runtime import ${source} creates a generated-module cycle in ${join(root, 'routes/v1/notes.ts')}. Use a type-only import or shared domain module.`
    );
  }
});

test('a route may import the generated base and routes helper, and any generated module by type alone', () => {
  const root = project({
    'routes/v1/notes.ts':
      "import { defineRoute } from '#maximus/routes';\nexport const GET = defineRoute('listNotes', {}, async () => ({}));",
    'routes/v1/tags.ts': "import { base } from '../../.maximus/base.ts';\nexport default () => base;",
    'routes/v1/tasks.get.ts':
      "import type { app } from '#maximus/app';\nexport type Operations = typeof app.operations;\nexport default defineHandler({});",
  });
  expect(prepareProject(root).modules).toMatchObject({ routes: 3 });
  const app = generated(root, 'app.ts');
  expect(app).toContain('routes_0.GET("/v1/notes", "GET")');
  expect(app).toContain('routes_1("/v1/tags")');
  expect(app).toContain('bindRoute(base, routes_2, "/v1/tasks", "GET")');
});

test('middleware may not import the generated base, routes or app at runtime, but may name their types', () => {
  for (const [contents, source] of [
    ["import { base } from '#maximus/base';\nexport default base;", '#maximus/base'],
    [
      "import { defineRoute } from '../.maximus/routes.ts';\nexport default defineRoute;",
      '../.maximus/routes.ts',
    ],
    ["import { app } from '#maximus/app';\nexport default app;", '#maximus/app'],
  ] as const) {
    const root = project({ 'middleware/10-policy.ts': contents });
    expect(() => prepareProject(root), contents).toThrow(
      `Runtime import ${source} creates a generated-module cycle in ${join(root, 'middleware/10-policy.ts')}.`
    );
  }
  const typed = project({
    'middleware/10-policy.ts': [
      "import type { base } from '#maximus/base';",
      "import { type defineRoute } from '#maximus/routes';",
      "export type { app } from '#maximus/app';",
      'export type Policy = [typeof base, typeof defineRoute];',
      'export default {};',
    ].join('\n'),
  });
  expect(prepareProject(typed).modules).toMatchObject({ middleware: 1 });
});

test('configuration stays importable outside workerd: Workers-only imports are refused, their types are not', () => {
  for (const [file, contents, source] of [
    [
      'maximus.config.ts',
      "import { env } from 'cloudflare:workers';\nexport default env;",
      'cloudflare:workers',
    ],
    [
      'errors.ts',
      "import { createWorker } from '@arbol-ai/maximus/workers';\nexport default createWorker;",
      '@arbol-ai/maximus/workers',
    ],
    [
      'errors.ts',
      "export { createProjectWorker } from '@arbol-ai/maximus/project';\nexport default {};",
      '@arbol-ai/maximus/project',
    ],
  ] as const) {
    const root = project({ [file]: contents });
    expect(() => prepareProject(root), source).toThrow(
      `Configuration must remain importable outside workerd: ${source} in ${join(root, file)}. Import its types only.`
    );
  }
  const typed = project({
    'maximus.config.ts': [
      "import type { DurableObject } from 'cloudflare:workers';",
      "import { defineErrors } from '@arbol-ai/maximus';",
      "import { defineConfig } from '@arbol-ai/maximus/config';",
      'export type Store = DurableObject;',
      'export default defineConfig({ errors: defineErrors({}) });',
    ].join('\n'),
  });
  expect(prepareProject(typed)).toMatchObject({ layout: 'config' });
});

test('a module that does not parse is refused with what the parser found', () => {
  const root = project({ 'routes/v1/notes.ts': 'export const GET = {' });
  expect(() => prepareProject(root)).toThrow(
    new RegExp(`^Cannot discover ${join(root, 'routes/v1/notes.ts')}: .+`)
  );
});

test('a route module of named methods may export types beside them, and nothing else', () => {
  const typed = project({
    'routes/v1/notes.ts':
      'export type Note = { id: string };\nexport interface Page { notes: Note[] }\nexport const GET = {};',
  });
  prepareProject(typed);
  expect(generated(typed, 'app.ts')).toContain('.mount(routes_0.GET("/v1/notes", "GET"))');
  for (const contents of [
    'export const GET = {};\nexport const helper = 1;',
    'export const handler = {};',
    '',
  ]) {
    const root = project({ 'routes/v1/notes.ts': contents });
    expect(() => prepareProject(root), contents).toThrow(
      `Route ${join(root, 'routes/v1/notes.ts')} must export GET, POST, PUT, PATCH or DELETE. Keep helpers private or in _files.`
    );
  }
});

test('a declaration default-exported through a binding is still the module’s declaration', () => {
  const root = project({
    'routes/v1/notes.get.ts': 'const listNotes = defineHandler({});\nexport { listNotes as default };',
    'mcp/tools/summarize.ts': 'const summarize = defineTool({});\nexport default summarize;',
  });
  prepareProject(root);
  const app = generated(root, 'app.ts');
  expect(app).toContain('.mount(bindRoute(base, routes_0, "/v1/notes", "GET"))');
  expect(app).toContain('.mount(bindTool(base, tools_0, "summarize"))');
});

test("a cron module's schedule is a declarator of an exported const; a let, a function or no export states none", () => {
  const root = project({
    'crons/a-daily.ts': "export const label = 'daily', cron = '0 8 * * *';\nexport default () => {};",
    'crons/b-hourly.ts': "export let cron = '0 * * * *';\nexport default () => {};",
    'crons/c-weekly.ts': "export function cron() {\n  return '0 8 * * 1';\n}\nexport default () => {};",
    'crons/d-unscheduled.ts': 'export default () => {};',
  });
  expect(prepareProject(root).crons.map(({ cron }) => cron)).toEqual([
    '0 8 * * *',
    undefined,
    undefined,
    undefined,
  ]);
});

test('two page files may not claim one path', () => {
  const root = project({
    'pages/about.ts': 'export default {};',
    'pages/about/index.ts': 'export default {};',
  });
  expect(() => prepareProject(root)).toThrow('Multiple page files claim /about.');
});

test('queue and email modules are top-level files with distinct names', () => {
  for (const [files, message] of [
    [{ 'queues/team/jobs.ts': '' }, 'queues modules require distinct top-level names: team/jobs'],
    [
      { 'queues/jobs.ts': '', 'queues/jobs.mts': '' },
      'queues modules require distinct top-level names: jobs',
    ],
    [
      { 'email/help@example.com.ts': '', 'email/help@example.com.js': '' },
      'email modules require distinct top-level names: help@example.com',
    ],
    [
      { 'email/team/help@example.com.ts': '' },
      'email modules require distinct top-level names: team/help@example.com',
    ],
  ] as const) {
    const root = project(files);
    expect(() => prepareProject(root), message).toThrow(message);
  }
});

test('Durable Object files are top-level kebab-case names whose class no other Worker export takes', () => {
  for (const [files, message] of [
    [
      { 'durable-objects/SessionStore.ts': '' },
      'Durable Object filenames must be top-level kebab-case names: SessionStore',
    ],
    [
      { 'durable-objects/team/store.ts': '' },
      'Durable Object filenames must be top-level kebab-case names: team/store',
    ],
    // The generated native RPC entrypoint is Service.
    [{ 'durable-objects/service.ts': '' }, 'Duplicate Worker export: Service'],
    [{ 'durable-objects/store.ts': '', 'durable-objects/store.mts': '' }, 'Duplicate Worker export: Store'],
  ] as const) {
    const root = project(files);
    expect(() => prepareProject(root), message).toThrow(message);
  }
});
