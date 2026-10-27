/**
 * What project discovery refuses at its boundaries, beside the generator's main matrix: root modules and
 * generated output that are symlinks or not ordinary files, runtime imports of generated modules that would
 * form a cycle for each kind of module, Workers-only imports in the modules that complete the application,
 * modules that do not parse, cron schedules that are not literal constants, and pages, events and Durable
 * Objects whose names collide.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vite-plus/test';

import { generated, prepare, project, removeProjects, ROUTE, temporary, write } from './fixtures.ts';

afterEach(removeProjects);

test('a root module or the generated directory that is a symlink is refused, and nothing is written through it', () => {
  for (const name of ['errors', 'auth', 'context']) {
    const linked = project({ [`shared/${name}.ts`]: 'export default {};' });
    symlinkSync(join(linked, `shared/${name}.ts`), join(linked, `${name}.ts`));
    expect(() => prepare(linked), name).toThrow(`The ${name} module cannot be a symlink.`);
  }
  const outside = temporary();
  const linkedOutput = project({ 'routes/v1/notes.get.ts': ROUTE });
  symlinkSync(outside, join(linkedOutput, '.maximus'));
  expect(() => prepare(linkedOutput)).toThrow('The generated .maximus directory cannot be a symlink.');
  expect(readdirSync(outside)).toEqual([]);
});

test('a generated file that is a symlink or a directory is refused before any output is replaced', () => {
  const root = project({ 'routes/v1/notes.get.ts': ROUTE });
  prepare(root);
  const app = generated(root, 'app.ts');
  const outside = temporary();
  writeFileSync(join(outside, 'worker.ts'), 'keep');
  rmSync(join(root, '.maximus/worker.ts'));
  symlinkSync(join(outside, 'worker.ts'), join(root, '.maximus/worker.ts'));
  // The new route changes app.ts, which must not be written while worker.ts is refused.
  write(root, { 'routes/v1/tags.get.ts': ROUTE });
  expect(() => prepare(root)).toThrow('Generated files must be ordinary files: worker.ts');
  expect(generated(root, 'app.ts')).toBe(app);
  expect(readFileSync(join(outside, 'worker.ts'), 'utf-8')).toBe('keep');
  rmSync(join(root, '.maximus/worker.ts'));
  mkdirSync(join(root, '.maximus/worker.ts'));
  expect(() => prepare(root)).toThrow('Generated files must be ordinary files: worker.ts');
  expect(generated(root, 'app.ts')).toBe(app);
});

test('a route may not import the generated app, Worker or entry at runtime, in any import or export form', () => {
  for (const [contents, source] of [
    ["import { app } from '#maximus/app';\nexport default app;", '#maximus/app'],
    [`import '../../.maximus/worker.ts';\n${ROUTE}`, '../../.maximus/worker.ts'],
    ["export { default } from '#maximus/entry';", '#maximus/entry'],
  ] as const) {
    const root = project({ 'routes/v1/notes.get.ts': contents });
    expect(() => prepare(root), contents).toThrow(
      `Runtime import ${source} creates a generated-module cycle in ${join(root, 'routes/v1/notes.get.ts')}. Use a type-only import or shared domain module.`
    );
  }
});

test('a route may import the generated base at runtime, and any generated module by type alone', () => {
  const root = project({
    'routes/v1/tags.get.ts': `import { base } from '../../.maximus/base.ts';\nexport default defineHandler(() => base);`,
    'routes/v1/tasks.get.ts': `import type { app } from '#maximus/app';\nexport type Operations = typeof app.operations;\n${ROUTE}`,
  });
  expect(prepare(root).modules).toMatchObject({ routes: 2 });
  const app = generated(root, 'app.ts');
  expect(app).toContain('bindRoute(base, route_0, "/v1/tags", "GET")');
  expect(app).toContain('bindRoute(base, route_1, "/v1/tasks", "GET")');
});

test('middleware may not import the generated base or app at runtime, but may name their types', () => {
  for (const [contents, source] of [
    ["import { base } from '#maximus/base';\nexport default base;", '#maximus/base'],
    ["import { app } from '#maximus/app';\nexport default app;", '#maximus/app'],
    ["import { Service } from '../.maximus/worker.ts';\nexport default Service;", '../.maximus/worker.ts'],
  ] as const) {
    const root = project({ 'middleware/10-policy.ts': contents });
    expect(() => prepare(root), contents).toThrow(
      `Runtime import ${source} creates a generated-module cycle in ${join(root, 'middleware/10-policy.ts')}.`
    );
  }
  const typed = project({
    'middleware/10-policy.ts': [
      "import type { base } from '#maximus/base';",
      "import { type app } from '#maximus/app';",
      "export type { middleware } from '#maximus/middleware';",
      'export type Policy = [typeof base, typeof app];',
      'export default {};',
    ].join('\n'),
  });
  expect(prepare(typed).modules).toMatchObject({ middleware: 1 });
});

test('the modules that complete the application stay importable outside workerd: Workers-only imports are refused, their types are not', () => {
  for (const [file, contents, source] of [
    ['auth.ts', "import { env } from 'cloudflare:workers';\nexport default env;", 'cloudflare:workers'],
    [
      'errors.ts',
      "import { createWorker } from '@arbol-ai/maximus/workers';\nexport default createWorker;",
      '@arbol-ai/maximus/workers',
    ],
    [
      'context.ts',
      "export { createProjectWorker } from '@arbol-ai/maximus/project';\nexport default {};",
      '@arbol-ai/maximus/project',
    ],
  ] as const) {
    const root = project({ [file]: contents });
    expect(() => prepare(root), source).toThrow(
      `Configuration must remain importable outside workerd: ${source} in ${join(root, file)}. Import its types only.`
    );
  }
  const typed = project({
    'context.ts': [
      "import type { DurableObject } from 'cloudflare:workers';",
      "import { defineContext } from '@arbol-ai/maximus';",
      'export type Store = DurableObject;',
      'export default defineContext(() => ({}));',
    ].join('\n'),
  });
  expect(prepare(typed).modules).toMatchObject({ routes: 0 });
});

test('a module that does not parse is refused with what the parser found', () => {
  const root = project({ 'routes/v1/notes.get.ts': 'export default defineHandler(() => {' });
  expect(() => prepare(root)).toThrow(
    new RegExp(`^Cannot discover ${join(root, 'routes/v1/notes.get.ts')}: .+`)
  );
});

test('a declaration default-exported through a binding is still the module’s declaration, beside its types', () => {
  const root = project({
    'routes/v1/notes.get.ts':
      'export type Note = { id: string };\nconst listNotes = defineHandler(() => {});\nexport { listNotes as default };',
    'mcp/tools/summarize.ts': 'const summarize = defineTool({});\nexport default summarize;',
  });
  prepare(root);
  const app = generated(root, 'app.ts');
  expect(app).toContain('.mount(bindRoute(base, route_0, "/v1/notes", "GET"))');
  expect(app).toContain('.mount(bindTool(base, tool_0, "summarize"))');
});

test("a cron module's schedule is a declarator of an exported const; a let, a function or no export states none", () => {
  const root = project({
    'crons/a-daily.ts': "export const label = 'daily', cron = '0 8 * * *';\nexport default () => {};",
    'crons/b-hourly.ts': "export let cron = '0 * * * *';\nexport default () => {};",
    'crons/c-weekly.ts': "export function cron() {\n  return '0 8 * * 1';\n}\nexport default () => {};",
    'crons/d-unscheduled.ts': 'export default () => {};',
  });
  expect(prepare(root).crons.map(({ cron }) => cron)).toEqual(['0 8 * * *', undefined, undefined, undefined]);
});

test('a cron module that does not parse, or imports the Worker that imports it, is refused before any output is replaced', () => {
  const root = project({ 'routes/v1/notes.get.ts': ROUTE });
  prepare(root);
  const worker = generated(root, 'worker.ts');
  for (const contents of [
    "export const cron = '0 8 * * *';\nexport default () => {",
    "import { Service } from '#maximus/worker';\nexport const cron = '0 8 * * *';\nexport default () => Service;",
  ]) {
    write(root, { 'crons/daily.ts': contents });
    expect(() => prepare(root), contents).toThrow(join(root, 'crons/daily.ts'));
    expect(generated(root, 'worker.ts')).toBe(worker);
  }
});

test('a cron module may use the generated application, which does not import it', () => {
  const root = project({
    'crons/daily.ts':
      "import { app } from '#maximus/app';\nexport const cron = '0 8 * * *';\nexport default () => app;",
  });
  expect(prepare(root).crons).toEqual([{ file: join(root, 'crons/daily.ts'), cron: '0 8 * * *' }]);
  expect(generated(root, 'worker.ts')).toContain(
    'import cron_0, { cron as schedule_0 } from "../crons/daily.ts";'
  );
});

test('two page files may not claim one path', () => {
  const root = project({
    'pages/about.ts': 'export default {};',
    'pages/about/index.ts': 'export default {};',
  });
  expect(() => prepare(root)).toThrow('Multiple page files claim /about.');
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
    expect(() => prepare(root), message).toThrow(message);
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
    expect(() => prepare(root), message).toThrow(message);
  }
});
