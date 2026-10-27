/**
 * `maximus prepare` for a project configured in vite.config.ts: Vite loads the configuration, and the plugin
 * in it prepares the project as a build would. Projects that configure themselves elsewhere keep their path.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, expect, test } from 'vite-plus/test';

import { prepareConfiguredProject } from '../../src/tooling/internal/prepare-configured.ts';
import type { ProjectOptions } from '../../src/tooling/vite.ts';

/** Inside the workspace's node_modules, where the bundled configuration resolves Vite and its imports. */
const CACHE = fileURLToPath(new URL('../../../../node_modules/.cache/', import.meta.url));
/** The plugin's source, which the configurations import. */
const PLUGIN = fileURLToPath(new URL('../../src/tooling/vite.ts', import.meta.url));
const directories: string[] = [];

const options: ProjectOptions = {
  application: {
    name: 'tasks',
    namespace: 'tasks',
    title: 'Tasks',
    version: '1.0.0',
    origin: 'https://tasks.example.test',
    tokens: { issuer: 'https://issuer.example.test/', audience: 'https://tasks.example.test' },
    rpc: { callers: [] },
  },
  worker: { http: { basePath: '/api', healthPath: '/health' } },
  env: { production: {}, development: {} },
};

function project(files: Record<string, string>): string {
  mkdirSync(CACHE, { recursive: true });
  const root = mkdtempSync(join(CACHE, 'maximus-prepare-'));
  directories.push(root);
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), contents);
  }
  return root;
}

afterEach(() => {
  for (const root of directories.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepares a project through the plugin its vite.config.ts configures', async () => {
  const root = project({
    'vite.config.ts': `import { maximusProject } from ${JSON.stringify(PLUGIN)};\nexport default { plugins: [[maximusProject(() => (${JSON.stringify(options)}))]] };\n`,
    'routes/v1/tasks.get.ts': 'export default defineHandler({});',
  });
  expect(await prepareConfiguredProject(root, 'development')).toMatchObject({
    layout: 'options',
    mode: 'development',
  });
  expect(readFileSync(join(root, '.maximus/config.ts'), 'utf-8')).toContain(
    '"origin":"https://tasks.example.test"'
  );
});

test('keeps maximus.config.ts and the 7.3 entries, and needs a plugin to configure anything else', async () => {
  const configured = project({
    'vite.config.ts': 'export default {};',
    'maximus.config.ts': 'export default {};',
  });
  expect(await prepareConfiguredProject(configured)).toMatchObject({ layout: 'config' });
  const unconfigured = project({ 'vite.config.ts': 'export default { plugins: [] };' });
  await expect(prepareConfiguredProject(unconfigured)).rejects.toThrow(
    'Configure the application in vite.config.ts with maximus()'
  );
});
