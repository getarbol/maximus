/**
 * `@arbol-ai/maximus/vite`: one `vite.config.ts` configures a Maximus application and the Cloudflare Worker
 * that serves it. `maximus()` keeps the project's generated modules in step with its files and runs
 * Cloudflare's Vite plugin with the Worker its options describe.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cloudflare } from '@cloudflare/vite-plugin';
import type { PluginConfig } from '@cloudflare/vite-plugin';
import type { WorkerConfig } from 'cf/config';
import type { Plugin } from 'vite';

import { checkWebAppBuild, projectOptions, workerConfig } from './options.ts';
import type { MaximusOptions, Phase } from './options.ts';
import { maximusProject } from './project.ts';

export type { MaximusOptions, Phase, ServiceOptions, TokenOptions, WebAppOptions } from './options.ts';
export { auth0, cloudflareAccess } from './tokens.ts';
export type { Auth0Algorithm, Auth0Options, CloudflareAccessOptions } from './tokens.ts';

/**
 * The Maximus lint and format presets, for each of `lint` and `fmt` the configuration does not set itself.
 * They need oxlint, oxfmt and Ultracite, which the starters install; without them, Vite+'s defaults apply.
 */
async function presets(config: object): Promise<Record<string, unknown>> {
  const added: Record<string, unknown> = {};
  try {
    if (!('lint' in config)) {
      const { default: lint } = await import('@arbol-ai/maximus/oxlint');
      added.lint = { ...lint, options: { typeAware: false } };
    }
    if (!('fmt' in config)) {
      const { default: fmt } = await import('@arbol-ai/maximus/oxfmt');
      added.fmt = fmt;
    }
  } catch (error) {
    // Only a missing optional peer leaves Vite+'s defaults: a preset that fails otherwise would silently
    // drop the guardrails it enforces.
    if (!(error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND')) {
      throw error;
    }
  }
  return added;
}

/**
 * Maximus in Vite+: prepares the project from its files before every build and source change, brings the
 * Maximus lint and format presets, and builds, runs and deploys the Worker these options describe through
 * Cloudflare's Vite plugin.
 */
export function maximus(options: MaximusOptions): Plugin[] {
  const project = maximusProject((root, phase) => projectOptions(root, options, phase));
  let worker: WorkerConfig | undefined;
  const configure: Plugin = {
    name: 'maximus',
    enforce: 'pre',
    async config(config, { command, isPreview }) {
      const root = resolve(config.root ?? process.cwd());
      // Development is `vp dev`: a build or a preview is production, whatever its Vite mode.
      const phase: Phase = command === 'serve' && !isPreview ? 'development' : 'production';
      // A configuration file of the 7.x layouts would be a second, silently ignored, source of settings.
      for (const [file, subject] of [
        ['cloudflare.config.ts', 'the Worker'],
        ['maximus.config.ts', 'the application'],
      ] as const) {
        if (existsSync(join(root, file))) {
          throw new TypeError(`maximus() configures ${subject}: move ${file} into maximus()'s options.`);
        }
      }
      checkWebAppBuild(root, config);
      worker = workerConfig(root, phase, options, project.api.prepare(root, phase));
      return await presets(config);
    },
    // The Worker's build is minified unless the configuration says otherwise: a smaller upload, and less code
    // for each isolate to parse. Its source map still maps stack traces back to the sources.
    configEnvironment(name, config) {
      if (name !== 'client' && config.build?.minify === undefined) {
        return { build: { minify: true } };
      }
      return undefined;
    },
  };
  // Under Vitest, a project's tests import the generated application in Node: Cloudflare's plugin, which
  // would run them in workerd's dev environment, stays out, and `cloudflare:workers` is a stand-in.
  if (process.env.VITEST) {
    return [configure, project, testing()];
  }
  // Cloudflare's plugin parses what the customizer returns with its input schema, as it parses
  // cloudflare.config.ts; its type names the parsed form.
  const customize = () => worker as Exclude<PluginConfig['config'], (...args: never[]) => unknown>;
  return [configure, project, ...cloudflare({ config: customize })];
}

/** The path of this package's stand-in for `cloudflare:workers`, with this extension. */
function workersStandIn(extension: string): string {
  return fileURLToPath(new URL(`cloudflare-workers.${extension}`, import.meta.url));
}

/**
 * What a project's tests run with in Node: `cloudflare:workers` resolves to this package's stand-in, whose
 * entrypoint and Durable Object base classes keep the context and bindings a test constructs them with.
 * Maximus's own modules are inlined, so the generated Worker resolves the stand-in too.
 */
function testing(): Plugin {
  // The build ships JavaScript; this package's own tests run its sources.
  const workers = existsSync(workersStandIn('js')) ? workersStandIn('js') : workersStandIn('ts');
  return {
    name: 'maximus:test',
    config: () => ({
      resolve: { alias: { 'cloudflare:workers': workers } },
      test: { server: { deps: { inline: [/@arbol-ai\/maximus/] } } },
    }),
  };
}
