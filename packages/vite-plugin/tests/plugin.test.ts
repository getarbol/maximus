/**
 * maximus() in a Vite configuration: it prepares the project before Cloudflare's plugin reads the Worker,
 * brings the lint and format presets a configuration lacks, and refuses a second Worker configuration.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Plugin } from 'vite';
import { afterEach, expect, test } from 'vite-plus/test';

import { maximus } from '../src/index.ts';

const directories: string[] = [];
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'maximus-plugin-'));
  directories.push(root);
  for (const [name, contents] of Object.entries({
    'package.json': '{"name":"tasks","version":"1.0.0"}',
    ...files,
  })) {
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

/** Runs the `config` hook of maximus()'s own plugin, as Vite does before Cloudflare's. */
async function configure(plugins: Plugin[], config: Record<string, unknown>, mode = 'production') {
  const plugin = plugins.find(({ name }) => name === 'maximus');
  const hook = plugin?.config;
  if (typeof hook !== 'function') {
    throw new TypeError('maximus() has no config hook');
  }
  return (await hook.call({} as never, config, { mode, command: 'build' })) as Record<string, unknown>;
}

test('prepares the project and keeps Cloudflare’s plugin after its own', async () => {
  const root = project({ 'routes/v1/greeting.get.ts': 'export default defineHandler(() => {});' });
  const plugins = maximus({ origin: 'https://tasks.example.test', compatibilityDate: '2026-10-26' });
  expect(plugins.map(({ name }) => name).slice(0, 2)).toEqual(['maximus', 'maximus-project']);
  expect(plugins.some(({ name }) => name === 'vite-plugin-cloudflare')).toBe(true);
  await configure(plugins, { root });
  expect(readFileSync(join(root, '.maximus/app.ts'), 'utf-8')).toContain('"/v1/greeting", "GET"');
  expect(existsSync(join(root, '.maximus/env.d.ts'))).toBe(true);
});

test('brings the lint and format presets a configuration does not set itself', async () => {
  const root = project({});
  const plugins = maximus({ origin: 'https://tasks.example.test', compatibilityDate: '2026-10-26' });
  const added = await configure(plugins, { root });
  expect(added.lint).toMatchObject({ options: { typeAware: false } });
  expect(added.fmt).toMatchObject({ singleQuote: true });
  expect(await configure(plugins, { root, lint: {}, fmt: {} })).toEqual({});
});

test('refuses cloudflare.config.ts, which a second Worker configuration would be', async () => {
  const root = project({ 'cloudflare.config.ts': 'export default {};' });
  await expect(
    configure(maximus({ origin: 'https://tasks.example.test', compatibilityDate: '2026-10-26' }), { root })
  ).rejects.toThrow("maximus() configures the Worker: move cloudflare.config.ts into maximus()'s options.");
});

test('serves a web app from the root, refusing a base or assets directory that would move its build', async () => {
  const root = project({ 'index.html': '<!doctype html>' });
  const plugins = maximus({ origin: 'https://tasks.example.test', compatibilityDate: '2026-10-26' });
  await configure(plugins, { root, base: '/', build: { assetsDir: 'assets' } });
  for (const config of [
    { base: '/app/' },
    { build: { assetsDir: 'static' } },
    { environments: { client: { build: { assetsDir: 'static' } } } },
  ]) {
    await expect(configure(plugins, { root, ...config }), JSON.stringify(config)).rejects.toThrow(
      'maximus() serves a web app from the root with its hashed files below /assets'
    );
  }
  // Without index.html, the build is the project's own business.
  await configure(plugins, { root: project({}), base: '/app/' });
});

test("minifies the Worker's build, and only it, unless the configuration decides", () => {
  const plugins = maximus({ origin: 'https://tasks.example.test', compatibilityDate: '2026-10-26' });
  const hook = plugins.find(({ name }) => name === 'maximus')?.configEnvironment;
  if (typeof hook !== 'function') {
    throw new TypeError('maximus() has no configEnvironment hook');
  }
  const environment = (name: string, config: Record<string, unknown>) =>
    hook.call({} as never, name, config as never, { mode: 'production', command: 'build' } as never);
  expect(environment('tasks', {})).toEqual({ build: { minify: true } });
  expect(environment('tasks', { build: { minify: false } })).toBeUndefined();
  expect(environment('tasks', { build: { minify: 'terser' } })).toBeUndefined();
  // The browser's build keeps Vite's own default.
  expect(environment('client', {})).toBeUndefined();
});
