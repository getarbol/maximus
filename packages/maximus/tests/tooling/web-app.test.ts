/**
 * A web app in a project configured in vite.config.ts: index.html at the root, which the plugin reports with
 * the assets binding, and the pages app/routes/ declares. Prepare turns those files into React Router's routes
 * and into the Worker's asset policy: the shell for known pages alone, public/ by name, the hashed /assets/ for
 * good, and Vite's modules forwarded in development only.
 */
import { existsSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vite-plus/test';

import { generated, options, prepare, project, removeProjects } from './fixtures.ts';

afterEach(removeProjects);

/** What vite.config.ts states for a tasks service that is a web app. */
const web = options({ web: true });

/** The page patterns of the generated Worker's asset policy, as the regular expressions it compiles. */
function patterns(root: string): RegExp[] {
  const literals = /patterns: \[([^\]]*(?:\][^\]]*)*?)\] \}/.exec(generated(root, 'worker.ts'))?.[1] ?? '';
  return [...literals.matchAll(/\/(\^.*?\$)\//g)].map(([, source]) => new RegExp(source ?? ''));
}

const page = 'export default function Page() {\n  return null;\n}\n';

test('pages become lazy React Router routes in the root layout, and the paths the Worker answers with the shell', () => {
  const root = project({
    'index.html': '<!doctype html><div id="root"></div>',
    'app/root.tsx': page,
    'app/routes/index.tsx': page,
    'app/routes/tasks/index.tsx': page,
    'app/routes/tasks/[taskId].tsx': page,
    'app/routes/(account)/settings.tsx': page,
    'app/routes/_helpers.ts': 'export const shared = 1;',
    'public/favicon.svg': '<svg/>',
    'public/images/logo.png': '',
    'public/.hidden': '',
  });
  expect(prepare(root, 'production', web)).toMatchObject({ webApp: true, modules: { app: 4 } });
  const routes = generated(root, 'app-routes.ts');
  expect(routes).toContain("import type { RouteObject } from 'react-router';");
  expect(routes).toContain('import * as layout from "../app/root.tsx";');
  expect(routes).toContain('export const routes: RouteObject[] = [{ ...page(layout), children: [');
  expect(routes).toContain(
    '{ path: "/tasks/:taskId", caseSensitive: true, lazy: () => import("../app/routes/tasks/[taskId].tsx").then(page) }'
  );
  expect(routes).toContain('{ path: "/settings", caseSensitive: true,');
  expect(routes).not.toContain('_helpers');
  const worker = generated(root, 'worker.ts');
  expect(worker).toContain(
    'assets: { binding: "ASSETS", pages: { paths: ["/settings","/","/tasks"], patterns: ['
  );
  expect(worker).toContain(
    `files: ["/favicon.svg","/images/logo.png"], immutablePrefixes: ['/assets'], development: false }`
  );
  const [detail] = patterns(root);
  expect(detail?.test('/tasks/9f0c')).toBe(true);
  expect(detail?.test('/tasks/9f0c/notes')).toBe(false);
  expect(detail?.test('/tasks/')).toBe(false);
  // The binding is generated code's; the configuration carries plain data.
  expect(generated(root, 'config.ts')).not.toContain('assets');
  prepare(root, 'development', web);
  expect(generated(root, 'worker.ts')).toContain('development: true }');
});

test('without app/routes/, index.html is the one page, at the root, and no routes module is generated', () => {
  const root = project({ 'index.html': '<!doctype html>' });
  expect(prepare(root, 'production', web)).toMatchObject({ webApp: true, modules: { app: 0 } });
  expect(generated(root, 'worker.ts')).toContain('pages: { paths: ["/"], patterns: [] }, files: []');
  expect(existsSync(join(root, '.maximus/app-routes.ts'))).toBe(false);
});

test('a page without its own layout is a top-level route, and a mode-suffixed page joins its mode alone', () => {
  const root = project({ 'index.html': '', 'app/routes/index.tsx': page, 'app/routes/debug.dev.tsx': page });
  prepare(root, 'production', web);
  expect(generated(root, 'app-routes.ts')).toContain(
    'export const routes: RouteObject[] = [\n  { path: "/",'
  );
  expect(generated(root, 'app-routes.ts')).not.toContain('debug');
  prepare(root, 'development', web);
  expect(generated(root, 'app-routes.ts')).toContain('{ path: "/debug", caseSensitive: true,');
});

test('pages that are gone take their routes module with them', () => {
  const root = project({ 'index.html': '', 'app/routes/index.tsx': page });
  prepare(root, 'production', web);
  expect(existsSync(join(root, '.maximus/app-routes.ts'))).toBe(true);
  rmSync(join(root, 'app'), { recursive: true });
  expect(prepare(root, 'production', web).changed).toBe(true);
  expect(existsSync(join(root, '.maximus/app-routes.ts'))).toBe(false);
});

test('pages need index.html, and a project without a web app has no asset policy', () => {
  const pages = project({ 'app/routes/index.tsx': page });
  expect(() => prepare(pages)).toThrow(
    'app/routes/ holds the pages of a web app: add its index.html at the project root.'
  );
  const api = project({ 'routes/v1/tasks.get.ts': 'export default defineHandler(() => ({}));' });
  expect(prepare(api)).toMatchObject({ webApp: false });
  expect(generated(api, 'worker.ts')).not.toContain('assets:');
});

test('two pages may not claim one path, whatever their parameters are named', () => {
  for (const [files, claim] of [
    [{ 'app/routes/tasks.tsx': page, 'app/routes/tasks/index.tsx': page }, '/tasks'],
    [{ 'app/routes/tasks/[id].tsx': page, 'app/routes/tasks/[taskId].tsx': page }, '/tasks/:taskId'],
    [{ 'app/routes/(account)/about.tsx': page, 'app/routes/about.tsx': page }, '/about'],
  ] as const) {
    const root = project({ 'index.html': '', ...files });
    expect(() => prepare(root, 'production', web), claim).toThrow(`Multiple page files claim ${claim}:`);
  }
});

test('a page may not claim a path the API, discovery, MCP, the build or pages/ answer', () => {
  for (const [file, route] of [
    ['app/routes/api/[key].tsx', '/api/:key'],
    ['app/routes/health.tsx', '/health'],
    ['app/routes/mcp.tsx', '/mcp'],
    ['app/routes/assets/logo.tsx', '/assets/logo'],
    ['app/routes/v1/tasks.tsx', '/v1/tasks'],
  ] as const) {
    const root = project({ 'index.html': '', [file]: page });
    expect(() => prepare(root, 'production', web), file).toThrow(
      `The page ${route} claims a path the API, discovery, MCP, the build's assets or pages/ answer: move it in app/routes/.`
    );
  }
  const both = project({
    'index.html': '',
    'pages/about.ts': 'export default () => new Response();',
    'app/routes/about.tsx': page,
  });
  expect(() => prepare(both, 'production', web)).toThrow('The page /about claims a path');
  // Without app/routes/, the root page is index.html's, which pages/index.ts may not answer either.
  const root = project({ 'index.html': '', 'pages/index.ts': 'export default () => new Response();' });
  expect(() => prepare(root, 'production', web)).toThrow('The page / claims a path');
  const rooted = project({ 'index.html': '' });
  expect(() => prepare(rooted, 'production', options({ web: true, basePath: '/' }))).toThrow(
    'A web app answers at the root: keep the API below http.basePath, /api by default.'
  );
});

test('a page is a name or a [parameter], and the root layout is one module', () => {
  const rest = project({ 'index.html': '', 'app/routes/files/[...path].tsx': page });
  expect(() => prepare(rest, 'production', web)).toThrow(
    'Unsupported app segment: [...path]. Pages use fixed paths; operations and app pages support [parameter].'
  );
  const layouts = project({ 'index.html': '', 'app/root.tsx': page, 'app/root.jsx': page });
  expect(() => prepare(layouts, 'production', web)).toThrow(
    'Keep at most one app/root module: app/root.tsx or app/root.jsx.'
  );
});

test('public/ files are served by plain names, and neither symlinks nor app/ itself may lead elsewhere', () => {
  const spaced = project({ 'index.html': '', 'public/my logo.png': '' });
  expect(() => prepare(spaced, 'production', web)).toThrow(
    'Name public files with letters, digits, dots, underscores, tildes and hyphens: public/my logo.png'
  );
  const linkedFile = project({ 'index.html': '', 'shared/logo.png': '', 'public/robots.txt': '' });
  symlinkSync(join(linkedFile, 'shared/logo.png'), join(linkedFile, 'public/logo.png'));
  expect(() => prepare(linkedFile, 'production', web)).toThrow(
    'Public files cannot be symlinks: public/logo.png'
  );
  const linkedPublic = project({ 'index.html': '', 'shared/logo.png': '' });
  symlinkSync(join(linkedPublic, 'shared'), join(linkedPublic, 'public'));
  expect(() => prepare(linkedPublic, 'production', web)).toThrow(
    'Project directory cannot be a symlink: public'
  );
  const linkedApp = project({ 'index.html': '', 'elsewhere/routes/index.tsx': page });
  symlinkSync(join(linkedApp, 'elsewhere'), join(linkedApp, 'app'));
  expect(() => prepare(linkedApp, 'production', web)).toThrow('Project directory cannot be a symlink: app');
});
