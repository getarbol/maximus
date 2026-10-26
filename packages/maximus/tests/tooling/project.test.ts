import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, expect, test } from 'vite-plus/test';

import { prepareProject } from '../../src/tooling/internal/prepare-project.ts';

const directories: string[] = [];

function project(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'maximus-project-'));
  directories.push(root);
  for (const [name, contents] of Object.entries({
    'src/application.ts': 'export const base = {};',
    'src/worker.ts': 'export const options = {};',
    ...files,
  })) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

afterEach(() => {
  for (const root of directories.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discovery creates static typed imports without evaluating modules', () => {
  const root = project({
    'routes/(team)/v1/notes/[noteId].ts': 'throw new Error("must not execute during discovery");',
    'pages/index.ts': 'export default {};',
    'middleware/02-second.ts': 'export default {};',
    'middleware/01-first.ts': 'export default {};',
    'durable-objects/session-store.ts': 'export default class SessionStore {}',
  });
  prepareProject(root);
  expect(readFileSync(join(root, '.maximus/app.ts'), 'utf-8')).toContain(
    '.mount(routes_0("/v1/notes/{noteId}"))'
  );
  const middleware = readFileSync(join(root, '.maximus/middleware.ts'), 'utf-8');
  expect(middleware.indexOf('01-first')).toBeLessThan(middleware.indexOf('02-second'));
  expect(readFileSync(join(root, '.maximus/worker.ts'), 'utf-8')).toContain(
    'export const SessionStore = worker.durableObject('
  );
});

test('mode filtering excludes helpers and tests even when a test carries a mode suffix', () => {
  const root = project({
    'routes/v1/live.prod.ts': '',
    'routes/v1/debug.dev.ts': '',
    'routes/v1/hidden.test.prod.ts': '',
    'routes/v1/_helpers.ts': '',
    'email/_default.ts': '',
  });
  expect(prepareProject(root).modules).toMatchObject({ routes: 1, email: 1 });
  const production = readFileSync(join(root, '.maximus/app.ts'), 'utf-8');
  expect(production).toContain('live.prod.ts');
  expect(production).not.toContain('debug');
  prepareProject(root, 'development');
  expect(readFileSync(join(root, '.maximus/app.ts'), 'utf-8')).toContain('debug.dev.ts');
});

test('colliding index and group routes are refused before replacing generated files', () => {
  const root = project({ 'routes/v1/notes.ts': '' });
  prepareProject(root);
  const original = readFileSync(join(root, '.maximus/app.ts'), 'utf-8');
  mkdirSync(join(root, 'routes/v1/notes'));
  writeFileSync(join(root, 'routes/v1/notes/index.ts'), '');
  expect(() => prepareProject(root)).toThrow('Multiple route files claim /v1/notes');
  expect(readFileSync(join(root, '.maximus/app.ts'), 'utf-8')).toBe(original);
});

test('module symlinks cannot pull code from outside the project', () => {
  const root = project({ 'routes/v1/notes.ts': '' });
  symlinkSync(join(root, 'src/application.ts'), join(root, 'routes/v1/external.ts'));
  expect(() => prepareProject(root)).toThrow('Project modules cannot be symlinks');
});
