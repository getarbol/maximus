/**
 * What `vite.config.ts` states and what follows from it: the application the generated modules carry and
 * the Worker Cloudflare's plugin builds. Development is `vp dev`: every build is a production build, whatever
 * its Vite mode, so no deployed Worker carries what only development needs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { bindings, triggers } from 'cf/config';
import type { WorkerConfig } from 'cf/config';
import type { UserConfig } from 'vite';

import type { TokenDevelopment, TokenPolicy } from '../tokens.ts';
import type { ProjectOptions } from '../tooling/internal/prepare-project.ts';

/** Where the Worker runs: `development` under `vp dev`, `production` in every build. */
export type Phase = 'development' | 'production';

/** How tokens are verified, as configuration states it; the code that verifies them itself is `auth.ts`. */
export type TokenOptions = Omit<
  TokenPolicy,
  'resolve' | 'resources' | 'resourceMetadataUrl' | 'audience' | 'development'
> & {
  /** The audience tokens must carry, or several any one of which they may carry; by default, the origin. */
  audience?: TokenPolicy['audience'];
  /**
   * The token `vp dev` accepts from localhost: its binding, `DEVELOPMENT_TOKEN` by default, which only
   * `vp dev` declares. `false` accepts none.
   */
  development?: TokenDevelopment | false;
};

/** What a web app (`index.html` at the project's root) answers with, besides its build. */
export interface WebAppOptions {
  /**
   * Response headers for the app's pages and files, merged over Maximus's defaults: a Content Security Policy
   * that admits the app's own origin and its token issuer, `frame-ancestors 'none'`, `no-referrer`, same-origin
   * opener and resource policies, and HSTS. A header set to `false` is left out. Under `vp dev` the policy and
   * HSTS are left out, since Vite's development client runs inline scripts over plain HTTP.
   */
  headers?: Readonly<Record<string, string | false>>;
}

/**
 * What `vite.config.ts` states: the application's configuration, and the Worker's settings as Cloudflare
 * names them. Maximus owns the Worker's entry and, for a web app, its assets; it adds `nodejs_compat` and,
 * under `vp dev`, the development token. The code that completes the application is `errors.ts`, `auth.ts`,
 * `context.ts` and `telemetry.ts`.
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
  /**
   * The public HTTPS origin OpenAPI, MCP resources and OAuth discovery advertise. A `workers.dev` origin is
   * served there; any other is the Worker's custom domain, unless `domains` or a fetch trigger route it.
   */
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
  /** What a web app answers with besides its build: its response headers. */
  webApp?: WebAppOptions;
}

/**
 * The Worker's observability: the options' own settings, key by key over the defaults, which are logs with
 * invocation logs and traces, query strings redacted. Logs and traces follow `enabled` unless the options set
 * theirs, so turning observability off turns them off too.
 */
function observability(own: WorkerConfig['observability'] = {}): WorkerConfig['observability'] {
  const enabled = own.enabled ?? true;
  return {
    enabled,
    redactQueryString: true,
    ...own,
    logs: { enabled, invocationLogs: true, ...own.logs },
    traces: { enabled, ...own.traces },
  };
}

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
    webApp,
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
    webApp,
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
 * The Worker's bindings in a phase: the declared ones, a web app's assets and, under `vp dev` alone, the
 * development token.
 */
function workerEnv(root: string, options: MaximusOptions, phase: Phase): Record<string, unknown> {
  const declared = Object.fromEntries(Object.entries(options.env ?? {}).filter(([, binding]) => binding));
  const development = developmentToken(options);
  if (development && Object.hasOwn(declared, development.binding)) {
    throw new TypeError(
      `${development.binding} is the development token: Maximus declares it under vp dev alone, so no deployed Worker carries it.`
    );
  }
  const web = servesWebApp(root);
  if (web && Object.hasOwn(declared, ASSETS)) {
    throw new TypeError(`${ASSETS} serves the web app index.html starts: Maximus declares it.`);
  }
  return {
    ...declared,
    ...(web ? { [ASSETS]: bindings.assets() } : {}),
    ...(development && phase === 'development' ? { [development.binding]: bindings.secret() } : {}),
  };
}

/** The origins the web app's pages may call besides their own: the token issuer's and its token endpoint's. */
function tokenOrigins(tokens: TokenOptions | undefined): string[] {
  if (!tokens?.issuer) {
    return [];
  }
  const issuer = new URL(tokens.issuer);
  const endpoint = new URL(tokens.tokenEndpoint ?? 'oauth/token', issuer);
  return [...new Set([issuer.origin, endpoint.origin])];
}

/**
 * The headers of a web app's pages and files: the defaults, then the options' own, a `false` one left out.
 * The Content Security Policy and HSTS apply in production alone.
 */
function webAppHeaders(options: MaximusOptions, phase: Phase): Record<string, string> {
  const production = phase === 'production';
  const policy = [
    "default-src 'self'",
    "base-uri 'self'",
    `connect-src ${["'self'", ...tokenOrigins(options.tokens)].join(' ')}`,
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    'upgrade-insecure-requests',
  ].join('; ');
  const headers: Record<string, string | false> = {
    ...(production
      ? {
          'content-security-policy': policy,
          'strict-transport-security': 'max-age=31536000; includeSubDomains',
        }
      : {}),
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
  };
  for (const [name, value] of Object.entries(options.webApp?.headers ?? {})) {
    const header = name.toLowerCase();
    if (production || (header !== 'content-security-policy' && header !== 'strict-transport-security')) {
      headers[header] = value;
    }
  }
  return Object.fromEntries(
    Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== false)
  );
}

/**
 * What the generated modules carry in a phase: the application this file configures, with the development
 * token's policy under `vp dev` alone, and a web app's binding and headers.
 */
export function projectOptions(
  root: string,
  options: MaximusOptions,
  phase: Phase = 'production'
): ProjectOptions {
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
      tokens: { ...tokens, audience, ...(development && phase === 'development' ? { development } : {}) },
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
      ...(servesWebApp(root) ? { assets: { binding: ASSETS, headers: webAppHeaders(options, phase) } } : {}),
    },
    env: {
      production: workerEnv(root, options, 'production'),
      development: workerEnv(root, options, 'development'),
    },
  };
}

/**
 * Where a deployment serves the Worker unless the options route it themselves: at its `workers.dev`
 * subdomain when the origin is one, and otherwise at the origin's host, as its custom domain alone.
 */
function hosting(options: MaximusOptions, worker: Omit<WorkerConfig, 'name' | 'entrypoint' | 'env'>) {
  const { hostname } = new URL(options.origin);
  const onWorkersDev = hostname.endsWith('.workers.dev');
  const routed = worker.domains !== undefined || worker.triggers?.some(({ type }) => type === 'fetch');
  return {
    workersDev: onWorkersDev,
    ...(onWorkersDev || routed ? {} : { domains: [hostname] }),
  };
}

/** What prepare found that the Worker's triggers follow: its cron modules and its queue modules. */
export interface DiscoveredEvents {
  /** Each cron module and the schedule it states as a literal. */
  crons: readonly { file: string; cron: string | undefined }[];
  /** The queues the queue modules consume, by their files' names. */
  queues: readonly string[];
}

/**
 * The Worker Cloudflare's plugin builds: the options' settings, the generated entry, `nodejs_compat`, which
 * Maximus needs for its diagnostics, the bindings of the phase, where it is served, its observability, a cron
 * trigger for each schedule the cron modules state, a consumer trigger for each queue module the options do not
 * subscribe themselves and, for a web app, its build as assets every request reaches through the Worker,
 * which decides what they answer.
 */
export function workerConfig(
  root: string,
  phase: Phase,
  options: MaximusOptions,
  { crons, queues }: DiscoveredEvents
): WorkerConfig {
  const { worker } = split(options);
  // The options' own consumer trigger for a queue (its batch size, its dead letter queue) is kept as it is.
  const subscribed = new Set(
    (worker.triggers ?? []).flatMap((trigger) => (trigger.type === 'queue' ? [trigger.name] : []))
  );
  const consumers = queues
    .filter((queue) => !subscribed.has(queue))
    .map((queue) => triggers.queue({ name: queue }));
  // One trigger per schedule, whose events run every cron module that states it; the options' own is kept.
  const declared = new Set(
    (worker.triggers ?? []).flatMap((trigger) => (trigger.type === 'scheduled' ? [trigger.schedule] : []))
  );
  const schedules = crons.map(({ file, cron }) => {
    if (cron === undefined) {
      throw new TypeError(
        `${file}: export the schedule as a string literal, export const cron = '0 8 * * *'.`
      );
    }
    return cron;
  });
  const scheduled = [...new Set(schedules)]
    .filter((schedule) => !declared.has(schedule))
    .map((schedule) => triggers.scheduled({ schedule }));
  return {
    ...hosting(options, worker),
    previewUrls: false,
    ...worker,
    observability: observability(worker.observability),
    name: identity(root, options).name,
    compatibilityFlags: [...new Set(['nodejs_compat', ...(worker.compatibilityFlags ?? [])])],
    entrypoint: './.maximus/entry.ts',
    ...(servesWebApp(root)
      ? { assets: { htmlHandling: 'none', notFoundHandling: 'none', runWorkerFirst: true } }
      : {}),
    env: workerEnv(root, options, phase) as WorkerConfig['env'],
    triggers: [...(worker.triggers ?? []), ...scheduled, ...consumers],
  };
}
