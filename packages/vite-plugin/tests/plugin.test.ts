/**
 * maximus() in a Vite configuration: it prepares the project before Cloudflare's plugin reads the Worker,
 * brings the lint and format presets a configuration lacks, and refuses a second Worker configuration.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Plugin } from 'vite';
import { afterEach, expect, test, vi } from 'vite-plus/test';

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

/** The `config` hook of one of maximus()'s plugins, by its name. */
function configHook(plugins: Plugin[], name: string) {
  const hook = plugins.find((plugin) => plugin.name === name)?.config;
  if (typeof hook !== 'function') {
    throw new TypeError(`${name} has no config hook`);
  }
  return hook;
}

/**
 * Runs the `config` hooks of maximus()'s plugins in Vite's order, its own and then maximusProject()'s, before
 * Cloudflare's: a build by default. Answers what maximus()'s own hook adds to the configuration.
 */
async function configure(
  plugins: Plugin[],
  config: Record<string, unknown>,
  environment: { mode?: string; command?: 'build' | 'serve'; isPreview?: boolean } = {}
) {
  const { mode = 'production', command = 'build', isPreview = false } = environment;
  const added = await configHook(plugins, 'maximus').call({} as never, config, { mode, command, isPreview });
  await configHook(plugins, 'maximus-project').call({} as never, config, { mode, command, isPreview });
  return added as Record<string, unknown>;
}

test('prepares the project and keeps Cloudflare’s plugin after its own, out of Vitest alone', async () => {
  const root = project({ 'routes/v1/greeting.get.ts': 'export default defineHandler(() => {});' });
  const options = { origin: 'https://tasks.example.test', compatibilityDate: '2026-10-26' };
  // Under Vitest, a project's tests import the generated application in Node, without workerd, and resolve
  // `cloudflare:workers` to the package's stand-in, Maximus's own modules included.
  const tested = maximus(options);
  expect(tested.map(({ name }) => name)).toEqual(['maximus', 'maximus-project', 'maximus:test']);
  const testing = tested[2]?.config;
  expect(
    typeof testing === 'function' && testing.call({} as never, {}, { mode: 'test', command: 'serve' })
  ).toEqual({
    resolve: {
      alias: { 'cloudflare:workers': expect.stringMatching(/testing[/\\]cloudflare-workers\.[jt]s$/) },
    },
    test: { server: { deps: { inline: [/@arbol-ai\/maximus/] } } },
  });
  vi.stubEnv('VITEST', '');
  const plugins = maximus(options);
  vi.unstubAllEnvs();
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

test('a preset that fails for any reason but a missing optional peer is never dropped silently', async () => {
  const root = project({});
  const options = { origin: 'https://tasks.example.test', compatibilityDate: '2026-10-26' };
  /** maximus() with the lint preset's module failing to load as `error` does. */
  const failing = async (error: Error) => {
    vi.resetModules();
    // The preset fails as the plugin reads it, as a module that cannot load would.
    vi.doMock('@arbol-ai/maximus/oxlint', () => ({
      get default(): never {
        throw error;
      },
    }));
    const { maximus: withFailingPreset } = await import('../src/index.ts');
    return configure(withFailingPreset(options), { root, fmt: {} });
  };
  try {
    // Without oxlint and Ultracite installed, Vite+'s own lint applies.
    const missing = Object.assign(new Error('Cannot find package oxlint'), { code: 'ERR_MODULE_NOT_FOUND' });
    expect(await failing(missing)).toEqual({});
    await expect(failing(new SyntaxError('Unexpected token in the preset'))).rejects.toThrow(
      'Unexpected token in the preset'
    );
  } finally {
    vi.doUnmock('@arbol-ai/maximus/oxlint');
    vi.resetModules();
  }
});

test('the stand-in for cloudflare:workers keeps what a test constructs a class with', async () => {
  const workers = await import('../src/testing/cloudflare-workers.ts');
  /** A Durable Object that answers what it was constructed with. */
  class Counter extends workers.DurableObject<{ LIMIT: number }> {
    limit = () => this.env.LIMIT;
    state = () => this.ctx;
  }
  const state = { id: 'clinic/2026-11-02' };
  expect(new Counter(state, { LIMIT: 3 }).limit()).toBe(3);
  expect(new Counter(state, { LIMIT: 3 }).state()).toBe(state);
  // An entrypoint keeps its context and bindings the same way.
  const context = { props: { caller: 'orders' } };
  const entrypoint = new workers.WorkerEntrypoint(context, { CURRENCY: 'USD' });
  expect([Reflect.get(entrypoint, 'ctx'), Reflect.get(entrypoint, 'env')]).toEqual([
    context,
    { CURRENCY: 'USD' },
  ]);
  expect(new workers.RpcTarget()).toBeInstanceOf(workers.RpcTarget);
  expect(workers.tracing.getActiveSpan).toBeUndefined();
});

test('refuses cloudflare.config.ts and maximus.config.ts, which a second configuration would be', async () => {
  for (const [file, subject] of [
    ['cloudflare.config.ts', 'the Worker'],
    ['maximus.config.ts', 'the application'],
  ] as const) {
    const root = project({ [file]: 'export default {};' });
    await expect(
      configure(maximus({ origin: 'https://tasks.example.test', compatibilityDate: '2026-10-26' }), { root }),
      file
    ).rejects.toThrow(`maximus() configures ${subject}: move ${file} into maximus()'s options.`);
  }
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

test('development is vp dev: a build or a preview is production, whatever its Vite mode', async () => {
  const root = project({
    'routes/v1/greeting.get.ts': 'export default defineHandler(() => {});',
    'routes/v1/debug.get.dev.ts': 'export default defineHandler(() => {});',
  });
  const plugins = maximus({ origin: 'https://tasks.example.test', compatibilityDate: '2026-10-26' });
  // What both hooks leave prepared: the development token and the development route, or neither.
  const development = async (environment: Parameters<typeof configure>[2]) => {
    await configure(plugins, { root, lint: {}, fmt: {} }, environment);
    return [
      readFileSync(join(root, '.maximus/config.ts'), 'utf-8').includes('DEVELOPMENT_TOKEN'),
      readFileSync(join(root, '.maximus/app.ts'), 'utf-8').includes('"/v1/debug"'),
    ];
  };
  expect(await development({ command: 'serve', mode: 'development' })).toEqual([true, true]);
  expect(await development({ command: 'serve', mode: 'staging' })).toEqual([true, true]);
  expect(await development({ command: 'build', mode: 'development' })).toEqual([false, false]);
  expect(await development({ command: 'serve', mode: 'development', isPreview: true })).toEqual([
    false,
    false,
  ]);
});
