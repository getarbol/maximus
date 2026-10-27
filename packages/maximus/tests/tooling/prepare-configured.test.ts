/**
 * `maximus prepare`: Vite loads the project's `vite.config.ts`, and the plugin in it prepares the project as a
 * build would. A project without one, or whose configuration has no `maximus()`, is refused.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, expect, test } from 'vite-plus/test';

import { prepareConfiguredProject } from '../../src/tooling/internal/prepare-configured.ts';
import { options, project, removeProjects, ROUTE } from './fixtures.ts';

/** Inside the workspace's node_modules, where the bundled configuration resolves Vite and its imports. */
const CACHE = fileURLToPath(new URL('../../../../node_modules/.cache/', import.meta.url));
/** The plugin's source, which the configurations import. */
const PLUGIN = fileURLToPath(new URL('../../src/tooling/vite.ts', import.meta.url));

afterEach(removeProjects);

test('prepares a project through the plugin its vite.config.ts configures, nested as Vite allows', async () => {
  const root = project(
    {
      'vite.config.ts': `import { maximusProject } from ${JSON.stringify(PLUGIN)};\nexport default { plugins: [[Promise.resolve(maximusProject(() => (${JSON.stringify(options())})))]] };\n`,
      'routes/v1/tasks.get.ts': ROUTE,
    },
    CACHE
  );
  expect(await prepareConfiguredProject(root, 'development')).toMatchObject({
    mode: 'development',
    modules: { routes: 1 },
  });
  expect(readFileSync(join(root, '.maximus/config.ts'), 'utf-8')).toContain(
    '"origin":"https://tasks.example.test"'
  );
});

test('of two configuration files, it reads the one Vite reads: vite.config.js before vite.config.ts', async () => {
  const root = project(
    {
      'vite.config.js': `import { maximusProject } from ${JSON.stringify(PLUGIN)};\nexport default { plugins: [maximusProject(() => (${JSON.stringify(options())}))] };\n`,
      'vite.config.ts': 'export default { plugins: [{ name: "other" }] };',
      'routes/v1/tasks.get.ts': ROUTE,
    },
    CACHE
  );
  expect(await prepareConfiguredProject(root)).toMatchObject({ mode: 'production', modules: { routes: 1 } });
});

test('a project without vite.config.ts, or whose configuration has no maximus(), is refused', async () => {
  const bare = project({ 'routes/v1/tasks.get.ts': ROUTE });
  await expect(prepareConfiguredProject(bare)).rejects.toThrow(
    'Configure the project in vite.config.ts with maximus() from @arbol-ai/vite-plugin.'
  );
  expect(existsSync(join(bare, '.maximus'))).toBe(false);
  const unconfigured = project(
    { 'vite.config.ts': 'export default { plugins: [{ name: "other" }] };' },
    CACHE
  );
  await expect(prepareConfiguredProject(unconfigured)).rejects.toThrow(
    'vite.config.ts configures no maximus() plugin from @arbol-ai/vite-plugin.'
  );
});
