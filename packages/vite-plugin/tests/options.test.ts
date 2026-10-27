/**
 * What follows from vite.config.ts's options: the application the generated modules carry, with defaults
 * from package.json, the development token declared in development alone, and the Worker Cloudflare's plugin
 * builds, with a trigger for each cron module.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bindings, triggers } from 'cf/config';
import { afterEach, expect, test } from 'vite-plus/test';

import { projectOptions, workerConfig } from '../src/options.ts';
import type { MaximusOptions } from '../src/options.ts';

const directories: string[] = [];
/** A project root with this package.json. */
function root(manifest: object = { name: '@acme/tasks', version: '2.1.0' }): string {
  const directory = mkdtempSync(join(tmpdir(), 'maximus-plugin-'));
  directories.push(directory);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const minimal: MaximusOptions = { origin: 'https://tasks.example.test', compatibilityDate: '2026-10-26' };

test('the service takes its name and version from package.json, and the rest from its name and origin', () => {
  expect(projectOptions(root(), minimal)).toEqual({
    application: {
      name: 'tasks',
      namespace: 'tasks',
      title: 'tasks',
      version: '2.1.0',
      origin: 'https://tasks.example.test',
      tokens: { audience: 'https://tasks.example.test' },
      rpc: { callers: [] },
    },
    worker: { http: { basePath: '/api', healthPath: '/health' } },
    env: { production: {}, development: { DEVELOPMENT_TOKEN: { type: 'secret' } } },
  });
});

test('the options state what package.json does not, and a name no Worker can take is refused', () => {
  const declared = projectOptions(root({}), {
    ...minimal,
    name: 'billing',
    namespace: 'pay',
    title: 'Billing',
    version: '3.0.0',
    tokens: { issuer: 'https://issuer.example.test/', audience: ['https://billing.example.test'] },
    rpc: { callers: ['ledger'] },
    http: { basePath: '/v', healthPath: '/up' },
    maxBodyBytes: 65_536,
    maxOutputBytes: 131_072,
    rateLimit: { binding: 'LIMITS' },
  });
  expect(declared?.application).toMatchObject({
    name: 'billing',
    namespace: 'pay',
    title: 'Billing',
    version: '3.0.0',
    tokens: { issuer: 'https://issuer.example.test/', audience: ['https://billing.example.test'] },
    rpc: { callers: ['ledger'] },
    maxBodyBytes: 65_536,
    maxOutputBytes: 131_072,
    rateLimit: { binding: 'LIMITS' },
  });
  expect(declared?.worker).toEqual({ http: { basePath: '/v', healthPath: '/up' } });
  expect(() => projectOptions(root({ name: 'Tasks App' }), minimal)).toThrow('Name the service');
  expect(() => projectOptions(root({}), minimal)).toThrow('Name the service');
  expect(projectOptions(root({ name: 'tasks' }), minimal)?.application.version).toBe('0.0.0');
});

test('the development token is declared in development alone, under its own binding, or not at all', () => {
  const kv = { TASKS: bindings.kv() };
  const options: MaximusOptions = {
    ...minimal,
    tokens: { development: { binding: 'LOCAL_TOKEN', organizationId: 'org_local' } },
    env: { ...kv, DISABLED: false, MISSING: null },
  };
  const custom = projectOptions(root(), options, 'development');
  expect(custom?.env).toEqual({ production: kv, development: { ...kv, LOCAL_TOKEN: { type: 'secret' } } });
  expect(custom?.application.tokens.development).toEqual({
    binding: 'LOCAL_TOKEN',
    organizationId: 'org_local',
  });
  // A production build carries neither the binding nor the policy that would accept its token.
  expect(projectOptions(root(), options, 'production')?.application.tokens).not.toHaveProperty('development');
  const none = projectOptions(root(), { ...minimal, tokens: { development: false }, env: kv });
  expect(none?.env).toEqual({ production: kv, development: kv });
  expect(none?.application.tokens).not.toHaveProperty('development');
  expect(() => projectOptions(root(), { ...minimal, env: { DEVELOPMENT_TOKEN: bindings.secret() } })).toThrow(
    'DEVELOPMENT_TOKEN is the development token'
  );
});

test('the Worker gets its entry, nodejs_compat once, the mode’s bindings and a trigger per cron module', () => {
  const daily = triggers.scheduled({ schedule: '0 1 * * *' });
  const options: MaximusOptions = {
    ...minimal,
    compatibilityFlags: ['nodejs_compat', 'streams_enable_constructors'],
    placement: { mode: 'smart' },
    triggers: [daily],
    env: { TASKS: bindings.kv() },
  };
  const crons = [{ file: 'crons/morning.ts', cron: '0 8 * * *' }];
  expect(workerConfig(root(), 'production', options, crons)).toEqual({
    name: 'tasks',
    compatibilityDate: '2026-10-26',
    compatibilityFlags: ['nodejs_compat', 'streams_enable_constructors'],
    entrypoint: './.maximus/entry.ts',
    workersDev: true,
    previewUrls: false,
    observability: {
      enabled: true,
      redactQueryString: true,
      logs: { enabled: true, invocationLogs: true },
      traces: { enabled: true },
    },
    placement: { mode: 'smart' },
    env: { TASKS: { type: 'kv' } },
    triggers: [daily, { type: 'scheduled', schedule: '0 8 * * *' }],
  });
  const development = workerConfig(
    root(),
    'development',
    { ...minimal, observability: { enabled: false } },
    []
  );
  expect(development).toMatchObject({
    compatibilityFlags: ['nodejs_compat'],
    observability: { enabled: false },
    env: { DEVELOPMENT_TOKEN: { type: 'secret' } },
    triggers: [],
  });
});

test('a cron module states its schedule as a literal, which becomes its trigger', () => {
  expect(() =>
    workerConfig(root(), 'production', minimal, [{ file: 'crons/hourly.ts', cron: undefined }])
  ).toThrow("crons/hourly.ts: export the schedule as a string literal, export const cron = '0 8 * * *'.");
});

test('a web app, index.html at the root, gets its assets binding in every mode and reaches every request', () => {
  const app = root();
  writeFileSync(join(app, 'index.html'), '<!doctype html><div id="root"></div>');
  const options: MaximusOptions = { ...minimal, env: { TASKS: bindings.kv() } };
  expect(projectOptions(app, options)).toMatchObject({
    worker: { http: { basePath: '/api', healthPath: '/health' }, assets: { binding: 'ASSETS' } },
    env: {
      production: { TASKS: { type: 'kv' }, ASSETS: { type: 'assets' } },
      development: {
        TASKS: { type: 'kv' },
        ASSETS: { type: 'assets' },
        DEVELOPMENT_TOKEN: { type: 'secret' },
      },
    },
  });
  const worker = workerConfig(app, 'production', options, []);
  expect(worker.assets).toEqual({ htmlHandling: 'none', notFoundHandling: 'none', runWorkerFirst: true });
  expect(worker.env).toEqual({ TASKS: { type: 'kv' }, ASSETS: { type: 'assets' } });
  // Without index.html, the Worker has no assets.
  expect(workerConfig(root(), 'production', options, []).assets).toBeUndefined();
  expect(projectOptions(root(), options)?.worker).toEqual({
    http: { basePath: '/api', healthPath: '/health' },
  });
});

test('a web app refuses a binding of its own named ASSETS', () => {
  const app = root();
  writeFileSync(join(app, 'index.html'), '<!doctype html>');
  expect(() => projectOptions(app, { ...minimal, env: { ASSETS: bindings.r2() } })).toThrow(
    'ASSETS serves the web app index.html starts: Maximus declares it.'
  );
});

test('assets are maximus()’s own, even from a JavaScript configuration that sets them', () => {
  const options = { ...minimal, assets: { directory: './public' } } as MaximusOptions;
  expect(() => workerConfig(root(), 'production', options, [])).toThrow(
    'maximus() configures the assets: index.html at the root makes the project a web app.'
  );
});
