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
/** A project without cron or queue modules. */
const NONE = { crons: [], queues: [] };

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
  expect(workerConfig(root(), 'production', options, { crons, queues: [] })).toEqual({
    name: 'tasks',
    compatibilityDate: '2026-10-26',
    compatibilityFlags: ['nodejs_compat', 'streams_enable_constructors'],
    entrypoint: './.maximus/entry.ts',
    workersDev: false,
    domains: ['tasks.example.test'],
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
    NONE
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
    workerConfig(root(), 'production', minimal, {
      crons: [{ file: 'crons/hourly.ts', cron: undefined }],
      queues: [],
    })
  ).toThrow("crons/hourly.ts: export the schedule as a string literal, export const cron = '0 8 * * *'.");
});

test('a web app, index.html at the root, gets its assets binding in every mode and reaches every request', () => {
  const app = root();
  writeFileSync(join(app, 'index.html'), '<!doctype html><div id="root"></div>');
  const options: MaximusOptions = { ...minimal, env: { TASKS: bindings.kv() } };
  expect(projectOptions(app, options)).toMatchObject({
    worker: {
      http: { basePath: '/api', healthPath: '/health' },
      assets: { binding: 'ASSETS', headers: expect.any(Object) },
    },
    env: {
      production: { TASKS: { type: 'kv' }, ASSETS: { type: 'assets' } },
      development: {
        TASKS: { type: 'kv' },
        ASSETS: { type: 'assets' },
        DEVELOPMENT_TOKEN: { type: 'secret' },
      },
    },
  });
  const worker = workerConfig(app, 'production', options, NONE);
  expect(worker.assets).toEqual({ htmlHandling: 'none', notFoundHandling: 'none', runWorkerFirst: true });
  expect(worker.env).toEqual({ TASKS: { type: 'kv' }, ASSETS: { type: 'assets' } });
  // Without index.html, the Worker has no assets.
  expect(workerConfig(root(), 'production', options, NONE).assets).toBeUndefined();
  expect(projectOptions(root(), options).worker).toEqual({
    http: { basePath: '/api', healthPath: '/health' },
  });
});

test('each queue module subscribes the Worker to its queue, unless the options subscribe it themselves', () => {
  const own = triggers.queue({ name: 'reminders', maxBatchSize: 10, deadLetterQueue: 'reminders-dead' });
  const { triggers: declared } = workerConfig(
    root(),
    'production',
    { ...minimal, triggers: [own] },
    {
      crons: [],
      queues: ['digests', 'reminders'],
    }
  );
  expect(declared).toEqual([own, { type: 'queue', name: 'digests' }]);
});

test('a workers.dev origin is served there, and any other is the custom domain unless the options route the Worker', () => {
  const at = (origin: string, extra: Partial<MaximusOptions> = {}) => {
    const { workersDev, domains } = workerConfig(
      root(),
      'production',
      { ...minimal, origin, ...extra },
      NONE
    );
    return { workersDev, domains };
  };
  expect(at('https://tasks.arbol.workers.dev')).toEqual({ workersDev: true, domains: undefined });
  expect(at('https://api.arbol.health')).toEqual({ workersDev: false, domains: ['api.arbol.health'] });
  expect(at('https://api.arbol.health', { domains: ['tasks.arbol.health'] })).toEqual({
    workersDev: false,
    domains: ['tasks.arbol.health'],
  });
  expect(
    at('https://api.arbol.health', { triggers: [triggers.fetch({ pattern: 'api.arbol.health/tasks/*' })] })
  ).toEqual({ workersDev: false, domains: undefined });
  expect(at('https://api.arbol.health', { workersDev: true })).toEqual({
    workersDev: true,
    domains: ['api.arbol.health'],
  });
});

test("a web app's pages and files carry secure headers, the policy admitting the token issuer, and the options' own", () => {
  const app = root();
  writeFileSync(join(app, 'index.html'), '<!doctype html>');
  const tokens = { issuer: 'https://auth.arbol.test/', tokenEndpoint: 'https://login.arbol.test/token' };
  const headers = (phase: 'development' | 'production', webApp?: MaximusOptions['webApp']) =>
    projectOptions(app, { ...minimal, tokens, webApp }, phase).worker.assets?.headers;
  expect(headers('production')).toEqual({
    'content-security-policy':
      "default-src 'self'; base-uri 'self'; connect-src 'self' https://auth.arbol.test https://login.arbol.test; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; upgrade-insecure-requests",
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
  });
  // vp dev runs Vite's inline client over plain HTTP: no policy and no HSTS, even the options' own.
  expect(
    headers('development', {
      headers: { 'Content-Security-Policy': "default-src 'none'", 'X-Frame-Options': false },
    })
  ).toEqual({
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
  });
  expect(
    headers('production', {
      headers: {
        'content-security-policy': "default-src 'self' https://cdn.arbol.test",
        'permissions-policy': 'camera=()',
      },
    })
  ).toMatchObject({
    'content-security-policy': "default-src 'self' https://cdn.arbol.test",
    'permissions-policy': 'camera=()',
  });
  // Without an issuer, the pages call their own origin alone.
  expect(projectOptions(app, minimal).worker.assets?.headers?.['content-security-policy']).toContain(
    "connect-src 'self';"
  );
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
  expect(() => workerConfig(root(), 'production', options, NONE)).toThrow(
    'maximus() configures the assets: index.html at the root makes the project a web app.'
  );
});
