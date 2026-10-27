import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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
    'routes/(team)/v1/notes/[noteId].ts':
      'throw new Error("must not execute during discovery"); export default () => ({});',
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
    'routes/v1/live.prod.ts': 'export default () => ({});',
    'routes/v1/debug.dev.ts': 'export default () => ({});',
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
  const root = project({ 'routes/v1/notes.ts': 'export default () => ({});' });
  prepareProject(root);
  const original = readFileSync(join(root, '.maximus/app.ts'), 'utf-8');
  mkdirSync(join(root, 'routes/v1/notes'));
  writeFileSync(join(root, 'routes/v1/notes/index.ts'), '');
  expect(() => prepareProject(root)).toThrow('Multiple route files claim /v1/notes');
  expect(readFileSync(join(root, '.maximus/app.ts'), 'utf-8')).toBe(original);
});

test('module symlinks cannot pull code from outside the project', () => {
  const root = project({ 'routes/v1/notes.ts': 'export default () => ({});' });
  symlinkSync(join(root, 'src/application.ts'), join(root, 'routes/v1/external.ts'));
  expect(() => prepareProject(root)).toThrow('Project modules cannot be symlinks');
});

test('root configuration supports named exports and reconciles method edits and route removal', () => {
  const root = project({
    'maximus.config.ts': 'throw new Error("configuration must not execute"); export default {};',
    'routes/v1/notes.ts': 'export const GET = {}; export const POST = {};',
  });
  rmSync(join(root, 'src'), { recursive: true });
  expect(prepareProject(root)).toMatchObject({ layout: 'config', changed: true });
  const app = () => readFileSync(join(root, '.maximus/app.ts'), 'utf-8');
  expect(app()).toContain('routes_0.GET("/v1/notes", "GET")');
  expect(app()).toContain('routes_0.POST("/v1/notes", "POST")');
  expect(prepareProject(root).changed).toBe(false);
  writeFileSync(join(root, 'routes/v1/notes.ts'), 'export const GET = {};');
  prepareProject(root);
  expect(app()).not.toContain('POST');
  unlinkSync(join(root, 'routes/v1/notes.ts'));
  prepareProject(root);
  expect(app()).not.toContain('routes_0');
  expect(readFileSync(join(root, '.maximus/base.ts'), 'utf-8')).toContain('../maximus.config.ts');
});

test('named methods can coexist with a legacy factory in another file', () => {
  const root = project({
    'routes/v1/notes.ts': 'export const GET = {};',
    'routes/v1/legacy.ts': 'export default () => ({});',
  });
  prepareProject(root);
  const app = readFileSync(join(root, '.maximus/app.ts'), 'utf-8');
  expect(app).toContain('routes_0("/v1/legacy")');
  expect(app).toContain('routes_1.GET("/v1/notes", "GET")');
});

test('ambiguous route forms and wildcard exports are rejected without replacing the graph', () => {
  const root = project({ 'routes/v1/notes.ts': 'export const GET = {};' });
  prepareProject(root);
  const app = readFileSync(join(root, '.maximus/app.ts'), 'utf-8');
  writeFileSync(join(root, 'routes/v1/notes.ts'), 'export const GET = {}; export default () => ({});');
  expect(() => prepareProject(root)).toThrow('Choose a default route factory or named method exports');
  expect(readFileSync(join(root, '.maximus/app.ts'), 'utf-8')).toBe(app);
  writeFileSync(join(root, 'routes/v1/notes.ts'), 'export * from "./_handlers";');
  expect(() => prepareProject(root)).toThrow('explicit exports');
});

test('suffixed modules declare one method each and share a path', () => {
  const root = project({
    'routes/v1/tasks/index.get.ts':
      'throw new Error("must not execute"); export default defineHandler({ output: {}, handler: () => ({}) });',
    'routes/v1/tasks/index.post.ts': 'export default defineHandler({});',
    'routes/v1/tasks/[taskId].delete.ts': 'export default defineHandler({}); export type Removed = true;',
    'routes/v1/debug.get.dev.ts': 'export default defineHandler({});',
  });
  prepareProject(root);
  const app = readFileSync(join(root, '.maximus/app.ts'), 'utf-8');
  expect(app).toContain("import { bindRoute, checkProjectPipeline } from '@arbol-ai/maximus/config';");
  expect(app).toContain('.mount(bindRoute(base, routes_0, "/v1/tasks/{taskId}", "DELETE"))');
  expect(app).toContain('.mount(bindRoute(base, routes_1, "/v1/tasks", "GET"))');
  expect(app).toContain('.mount(bindRoute(base, routes_2, "/v1/tasks", "POST"))');
  expect(app).not.toContain('debug');
  prepareProject(root, 'development');
  expect(readFileSync(join(root, '.maximus/app.ts'), 'utf-8')).toContain('"/v1/debug", "GET"');
  expect(readFileSync(join(root, '.maximus/register.d.ts'), 'utf-8')).toContain(
    'declare global {\n  interface MaximusRegister {\n    base: typeof base;'
  );
});

test('a method has one owner: a suffixed module, or the unsuffixed module of its path', () => {
  const twice = project({
    'routes/v1/tasks.get.ts': 'export default defineHandler({});',
    'routes/v1/tasks/index.get.ts': 'export default defineHandler({});',
  });
  expect(() => prepareProject(twice)).toThrow(
    'Multiple route files claim GET /v1/tasks: routes/v1/tasks.get.ts and routes/v1/tasks/index.get.ts.'
  );
  const mixed = project({
    'routes/v1/tasks.ts': 'export const GET = {};',
    'routes/v1/tasks.post.ts': 'export default defineHandler({});',
  });
  expect(() => prepareProject(mixed)).toThrow(
    'Multiple route files claim /v1/tasks: routes/v1/tasks.post.ts and routes/v1/tasks.ts.'
  );
});

test('a suffixed module exports its declaration and nothing else', () => {
  for (const contents of [
    'export const helper = 1; export default defineHandler({});',
    'export const GET = {};',
    'export * from "./_shared";',
  ]) {
    const root = project({ 'routes/v1/tasks.get.ts': contents });
    expect(() => prepareProject(root), contents).toThrow(
      'must default-export its defineHandler declaration and nothing else'
    );
  }
});

test('MCP tools are named by their file and bring the MCP transport, as a route tool does', () => {
  const root = project({
    'mcp/tools/summarize-tasks.ts': 'export default defineTool({});',
    'mcp/instructions.md': '# Not a module',
    'mcp/_shared.ts': 'export const ignored = true;',
  });
  prepareProject(root);
  expect(readFileSync(join(root, '.maximus/app.ts'), 'utf-8')).toContain(
    '.mount(bindTool(base, tools_0, "summarize-tasks"))'
  );
  const worker = readFileSync(join(root, '.maximus/worker.ts'), 'utf-8');
  expect(worker).toContain("import { mcp } from '@arbol-ai/maximus/mcp';");
  expect(worker).toContain("protocol === 'mcp'");

  const routeTool = project({
    'routes/v1/tasks.get.ts': 'export default defineHandler({ "mcp": { name: "list_tasks" } });',
  });
  prepareProject(routeTool);
  expect(readFileSync(join(routeTool, '.maximus/worker.ts'), 'utf-8')).toContain('mcp()');

  const plain = project({ 'routes/v1/tasks.get.ts': 'export default defineHandler({ rpc: true });' });
  prepareProject(plain);
  const plainWorker = readFileSync(join(plain, '.maximus/worker.ts'), 'utf-8');
  expect(plainWorker).not.toContain('@arbol-ai/maximus/mcp');
  expect(plainWorker).toContain('const transports = options.transports;');
});

test('an MCP module outside mcp/tools/, nested or misnamed is refused', () => {
  for (const name of ['mcp/helpers.ts', 'mcp/tools/team/summarize.ts', 'mcp/tools/Summarize.ts']) {
    const root = project({ [name]: 'export default defineTool({});' });
    expect(() => prepareProject(root), name).toThrow('kebab-case tools directly in mcp/tools/');
  }
});

test('a root errors module types failures, and the generated base checks the application uses it', () => {
  const root = project({ 'errors.ts': 'throw new Error("must not execute"); export default {};' });
  prepareProject(root);
  expect(readFileSync(join(root, '.maximus/register.d.ts'), 'utf-8')).toContain(
    "import type errors from '../errors.ts';"
  );
  expect(readFileSync(join(root, '.maximus/register.d.ts'), 'utf-8')).toContain('errors: typeof errors;');
  expect(readFileSync(join(root, '.maximus/base.ts'), 'utf-8')).toContain(
    'if (application.definition.errors !== errors) {'
  );
  writeFileSync(join(root, 'errors.mjs'), 'export default {};');
  expect(() => prepareProject(root)).toThrow('at most one errors module');
  rmSync(join(root, 'errors.mjs'));
  writeFileSync(join(root, 'errors.ts'), "import { app } from './.maximus/app.ts'; export default app;");
  expect(() => prepareProject(root)).toThrow('generated-module cycle');
});
