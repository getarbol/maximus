/**
 * What `vite.config.ts` states and what follows from it: the application the generated modules carry and
 * the Worker Cloudflare's plugin builds.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TokenDevelopment, TokenPolicy } from '@arbol-ai/maximus';
import type { ProjectOptions } from '@arbol-ai/maximus/vite';
import { bindings, triggers } from 'cf/config';
import type { WorkerConfig } from 'cf/config';
import type { UserConfig } from 'vite';

/** How tokens are verified, as configuration states it; the code that verifies them itself is `auth.ts`. */
export type TokenOptions = Omit<
  TokenPolicy,
  'resolve' | 'resources' | 'resourceMetadataUrl' | 'audience' | 'development'
> & {
  /** The audience tokens must carry, or several any one of which they may carry; by default, the origin. */
  audience?: TokenPolicy['audience'];
  /**
   * The token `vp dev` accepts from localhost: its binding, `DEVELOPMENT_TOKEN` by default, which only the
   * development build declares. `false` accepts none.
   */
  development?: TokenDevelopment | false;
};

/**
 * What `vite.config.ts` states: the application's configuration, and the Worker's settings as Cloudflare
 * names them. Maximus owns the Worker's entry and, for a web app, its assets; it adds `nodejs_compat` and, in
 * development, the development token. The code that completes the application is `errors.ts`, `auth.ts` and
 * `context.ts`.
 */
export interface MaximusOptions extends Omit<WorkerConfig, 'name' | 'entrypoint' | 'env' | 'assets'> {
  /**
   * The service's name: the Worker's, the MCP server's and the scopes' prefix. By default, the package's name
   * without its scope.
   */
  name?: string;
  /** The prefix of every scope, `<namespace>:<resource>:<action>`; by default, the name. */
  namespace?: string;
  /** The human name OpenAPI, the MCP server and OAuth discovery show; by default, the name. */
  title?: string;
  /** The version OpenAPI, the MCP server and `/health` report; by default, the package's version. */
  version?: string;
  /** The public HTTPS origin OpenAPI, MCP resources and OAuth discovery advertise. */
  origin: string;
  /** How tokens are verified: the OAuth issuer, the audience and the development token. */
  tokens?: TokenOptions;
  /** The Workers allowed to call native RPC methods, by the `caller` their Service Binding names; none by default. */
  rpc?: { callers: readonly string[] };
  /** Where the API and the health check answer: `/api` and `/health` by default. */
  http?: { basePath?: string; healthPath?: string };
  /** The request body limit of every operation that sets none, in bytes: 32 KiB by default. */
  maxBodyBytes?: number;
  /** The output limit of every operation that sets none, in bytes: 256 KiB by default. */
  maxOutputBytes?: number;
  /** A rate limiting binding every HTTP and MCP call passes, per organization and actor. */
  rateLimit?: { binding: string; retryAfter?: number };
  /** The Worker's bindings, from `cf/config`'s `bindings`; the generated `Env` is inferred from them. */
  env?: WorkerConfig['env'];
}

/** The observability a Worker gets unless the options set their own: logs and traces, query strings redacted. */
const OBSERVABILITY: WorkerConfig['observability'] = {
  enabled: true,
  redactQueryString: true,
  logs: { enabled: true, invocationLogs: true },
  traces: { enabled: true },
};

/** A Worker and scope namespace name: lowercase letters, digits and single hyphens, 2 to 63 characters. */
const SERVICE_NAME = /^(?=.{2,63}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** The application's options and the Worker's settings, apart. `assets` is maximus()'s own. */
function split(options: MaximusOptions) {
  if ('assets' in options) {
    throw new TypeError(
      'maximus() configures the assets: index.html at the root makes the project a web app.'
    );
  }
  const {
    name,
    namespace,
    title,
    version,
    origin,
    tokens,
    rpc,
    http,
    maxBodyBytes,
    maxOutputBytes,
    rateLimit,
    env,
    ...worker
  } = options;
  return {
    application: {
      name,
      namespace,
      title,
      version,
      origin,
      tokens,
      rpc,
      http,
      maxBodyBytes,
      maxOutputBytes,
      rateLimit,
    },
    env,
    worker,
  };
}

/** The binding a web app's build is served through. */
const ASSETS = 'ASSETS';

/** Whether the project is a web app: `index.html` at its root, which Vite builds for the browser. */
function servesWebApp(root: string): boolean {
  return existsSync(join(root, 'index.html'));
}

/**
 * A web app's build as its Worker serves it: from the root, its hashed files below `/assets`. Refuses a
 * configuration that moves them, whose app would otherwise miss its own files once deployed.
 */
export function checkWebAppBuild(root: string, config: UserConfig): void {
  const builds = [config.build, config.environments?.client?.build];
  if (
    servesWebApp(root) &&
    ((config.base ?? '/') !== '/' || builds.some((build) => (build?.assetsDir ?? 'assets') !== 'assets'))
  ) {
    throw new TypeError(
      'maximus() serves a web app from the root with its hashed files below /assets: keep base and build.assetsDir at their defaults.'
    );
  }
}

/** The service's name and version: the options', else the package's, its name without a scope. */
function identity(root: string, options: MaximusOptions): { name: string; version: string } {
  const path = join(root, 'package.json');
  const manifest: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {};
  const field = (key: string) =>
    typeof manifest === 'object' && manifest !== null && key in manifest
      ? Reflect.get(manifest, key)
      : undefined;
  const packageName = field('name');
  const packageVersion = field('version');
  const name =
    options.name ?? (typeof packageName === 'string' ? packageName.replace(/^@[^/]+\//, '') : undefined);
  if (name === undefined || !SERVICE_NAME.test(name)) {
    throw new TypeError(
      'Name the service with maximus({ name }), or in package.json: lowercase letters, digits and single hyphens.'
    );
  }
  return {
    name,
    version: options.version ?? (typeof packageVersion === 'string' ? packageVersion : '0.0.0'),
  };
}

/** The development token's policy: `DEVELOPMENT_TOKEN` unless the options name another or refuse it. */
function developmentToken(options: MaximusOptions): TokenDevelopment | undefined {
  const development = options.tokens?.development;
  return development === false ? undefined : (development ?? { binding: 'DEVELOPMENT_TOKEN' });
}

/**
 * The Worker's bindings in a mode: the declared ones, a web app's assets and, in development alone, the
 * development token.
 */
function workerEnv(root: string, options: MaximusOptions, mode: string): Record<string, unknown> {
  const declared = Object.fromEntries(Object.entries(options.env ?? {}).filter(([, binding]) => binding));
  const development = developmentToken(options);
  if (development && Object.hasOwn(declared, development.binding)) {
    throw new TypeError(
      `${development.binding} is the development token: Maximus declares it in development alone, so no deployed Worker carries it.`
    );
  }
  const web = servesWebApp(root);
  if (web && Object.hasOwn(declared, ASSETS)) {
    throw new TypeError(`${ASSETS} serves the web app index.html starts: Maximus declares it.`);
  }
  return {
    ...declared,
    ...(web ? { [ASSETS]: bindings.assets() } : {}),
    ...(development && mode === 'development' ? { [development.binding]: bindings.secret() } : {}),
  };
}

/**
 * What the generated modules carry in a mode: the application this file configures, with the development
 * token's policy in development alone.
 */
export function projectOptions(root: string, options: MaximusOptions, mode = 'production'): ProjectOptions {
  const { application } = split(options);
  const { name, version } = identity(root, options);
  const { audience = application.origin, development: _declared, ...tokens } = application.tokens ?? {};
  const development = developmentToken(options);
  return {
    application: {
      name,
      namespace: application.namespace ?? name,
      title: application.title ?? name,
      version,
      origin: application.origin,
      tokens: { ...tokens, audience, ...(development && mode === 'development' ? { development } : {}) },
      rpc: application.rpc ?? { callers: [] },
      ...(application.maxBodyBytes === undefined ? {} : { maxBodyBytes: application.maxBodyBytes }),
      ...(application.maxOutputBytes === undefined ? {} : { maxOutputBytes: application.maxOutputBytes }),
      ...(application.rateLimit === undefined ? {} : { rateLimit: application.rateLimit }),
    },
    worker: {
      http: {
        basePath: application.http?.basePath ?? '/api',
        healthPath: application.http?.healthPath ?? '/health',
      },
      ...(servesWebApp(root) ? { assets: { binding: ASSETS } } : {}),
    },
    env: {
      production: workerEnv(root, options, 'production'),
      development: workerEnv(root, options, 'development'),
    },
  };
}

/**
 * The Worker Cloudflare's plugin builds: the options' settings, the generated entry, `nodejs_compat`, which
 * Maximus needs for its diagnostics, the bindings of the mode, a cron trigger for each cron module and, for a
 * web app, its build as assets every request reaches through the Worker, which decides what they answer.
 */
export function workerConfig(
  root: string,
  mode: string,
  options: MaximusOptions,
  crons: readonly { file: string; cron: string | undefined }[]
): WorkerConfig {
  const { worker } = split(options);
  const scheduled = crons.map(({ file, cron }) => {
    if (cron === undefined) {
      throw new TypeError(
        `${file}: export the schedule as a string literal, export const cron = '0 8 * * *'.`
      );
    }
    return triggers.scheduled({ schedule: cron });
  });
  return {
    workersDev: true,
    previewUrls: false,
    observability: OBSERVABILITY,
    ...worker,
    name: identity(root, options).name,
    compatibilityFlags: [...new Set(['nodejs_compat', ...(worker.compatibilityFlags ?? [])])],
    entrypoint: './.maximus/entry.ts',
    ...(servesWebApp(root)
      ? { assets: { htmlHandling: 'none', notFoundHandling: 'none', runWorkerFirst: true } }
      : {}),
    env: workerEnv(root, options, mode) as WorkerConfig['env'],
    triggers: [...(worker.triggers ?? []), ...scheduled],
  };
}
