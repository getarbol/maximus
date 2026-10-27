/**
 * What follows from vite.config.ts's options: the application the generated modules carry, with defaults
 * from package.json, the development token declared in development alone, and the Worker Cloudflare's plugin
 * builds, with its observability over the defaults and a trigger for each schedule its cron modules state.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bindings, triggers } from 'cf/config';
import { afterEach, expect, test } from 'vite-plus/test';

import { maximus, standardErrors } from '../../src/index.ts';
import { projectOptions, workerConfig } from '../../src/vite/options.ts';
import type { MaximusOptions, TokenOptions } from '../../src/vite/options.ts';
import { auth0, cloudflareAccess } from '../../src/vite/tokens.ts';

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

test("each service the project calls is bound to its Worker's entrypoint, naming this service as the caller", () => {
  const services = { PRICING: { worker: 'pricing', openapi: '../pricing/openapi.rpc.json' } };
  const configured = projectOptions(root(), { ...minimal, services });
  const binding = { type: 'worker', worker: 'pricing', exportName: 'Service', props: { caller: 'tasks' } };
  expect(configured.env).toEqual({
    production: { PRICING: binding },
    development: { PRICING: binding, DEVELOPMENT_TOKEN: { type: 'secret' } },
  });
  expect(configured.services).toEqual(services);
  // A binding env declares too, a name that is no binding's, the development token's, and a service without
  // its Worker or document.
  for (const [refused, message] of [
    [{ ...minimal, services, env: { PRICING: bindings.kv() } }, 'services.PRICING: name each'],
    [
      { ...minimal, services: { DEVELOPMENT_TOKEN: services.PRICING } },
      'DEVELOPMENT_TOKEN is the development token',
    ],
    [{ ...minimal, services: { pricing: services.PRICING } }, 'services.pricing: name each'],
    [{ ...minimal, services: { PRICING: { worker: '', openapi: 'x.json' } } }, '{ worker, openapi }'],
    [{ ...minimal, services: { PRICING: { worker: 'pricing' } } }, '{ worker, openapi }'],
  ] as const) {
    expect(() => projectOptions(root(), refused as MaximusOptions)).toThrow(message);
  }
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

test('the Worker gets its entry, nodejs_compat once, the mode’s bindings and a trigger per cron schedule', () => {
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
  expect(workerConfig(root(), 'development', minimal, NONE)).toMatchObject({
    compatibilityFlags: ['nodejs_compat'],
    env: { DEVELOPMENT_TOKEN: { type: 'secret' } },
    triggers: [],
  });
});

test('the options’ observability joins the defaults key by key, and turning it off turns logs and traces off', () => {
  const observability = (own: MaximusOptions['observability']) =>
    workerConfig(root(), 'production', { ...minimal, observability: own }, NONE).observability;
  // A sampling rate keeps the logs, the traces and the redacted query strings.
  expect(observability({ headSamplingRate: 0.1 })).toEqual({
    enabled: true,
    headSamplingRate: 0.1,
    redactQueryString: true,
    logs: { enabled: true, invocationLogs: true },
    traces: { enabled: true },
  });
  expect(observability({ redactQueryString: false, logs: { invocationLogs: false } })).toEqual({
    enabled: true,
    redactQueryString: false,
    logs: { enabled: true, invocationLogs: false },
    traces: { enabled: true },
  });
  expect(observability({ enabled: false })).toEqual({
    enabled: false,
    redactQueryString: true,
    logs: { enabled: false, invocationLogs: true },
    traces: { enabled: false },
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

test('cron modules that state one schedule share its trigger, and the options’ own trigger for it is kept', () => {
  const hourly = triggers.scheduled({ schedule: '0 * * * *' });
  const crons = [
    { file: 'crons/digest.ts', cron: '0 8 * * *' },
    { file: 'crons/reminders.ts', cron: '0 8 * * *' },
    { file: 'crons/sweep.ts', cron: '0 * * * *' },
  ];
  const { triggers: declared } = workerConfig(
    root(),
    'production',
    { ...minimal, triggers: [hourly] },
    { crons, queues: [] }
  );
  expect(declared).toEqual([hourly, { type: 'scheduled', schedule: '0 8 * * *' }]);
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

/** An Access application's AUD tag. */
const AUD = '4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2';
/** A tasks service of one tenant behind Cloudflare Access, whose people read tasks. */
const ACCESS = cloudflareAccess({
  team: 'acme',
  aud: AUD,
  organizationId: 'org_acme',
  scopes: { people: ['tasks:tasks:read'] },
});

test('behind Cloudflare Access, a production build pins the Worker to its origin, and vp dev does not', () => {
  const production = projectOptions(root(), { ...minimal, tokens: ACCESS }, 'production');
  expect(production.worker.http).toEqual({
    basePath: '/api',
    healthPath: '/health',
    origins: ['https://tasks.example.test'],
  });
  expect(production.application.tokens).toEqual(ACCESS);
  const development = projectOptions(root(), { ...minimal, tokens: ACCESS }, 'development');
  expect(development.worker.http).toEqual({ basePath: '/api', healthPath: '/health' });
  expect(development.application.tokens.development).toEqual({ binding: 'DEVELOPMENT_TOKEN' });
  // OAuth access tokens leave the Worker where its origin and routes serve it.
  const oauth = auth0({ domain: 'acme.us.auth0.com', audience: 'https://tasks.example.test' });
  expect(projectOptions(root(), { ...minimal, tokens: oauth }).worker.http).not.toHaveProperty('origins');
  // The application the generated modules build from these options starts, in either phase.
  for (const { application } of [production, development]) {
    expect(() => maximus({ ...application, errors: standardErrors }).build()).not.toThrow();
  }
});

test("a web app's pages call each token issuer, and behind Cloudflare Access their own origin alone", () => {
  const app = root();
  writeFileSync(join(app, 'index.html'), '<!doctype html>');
  /** The `connect-src` of the pages' content security policy under these token options. */
  const connect = (tokens: TokenOptions) =>
    projectOptions(app, { ...minimal, tokens })
      .worker.assets?.headers?.['content-security-policy']?.split('; ')
      .find((directive) => directive.startsWith('connect-src'));
  expect(connect(ACCESS)).toBe("connect-src 'self'");
  expect(
    connect(
      auth0({ domain: ['login.acme.example', 'acme.us.auth0.com'], audience: 'https://tasks.example.test' })
    )
  ).toBe("connect-src 'self' https://login.acme.example https://acme.us.auth0.com");
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
