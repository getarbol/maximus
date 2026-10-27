/**
 * `@arbol-ai/vite-plugin`: one `vite.config.ts` configures a Maximus application and the Cloudflare Worker
 * that serves it. `maximus()` keeps the project's generated modules in step with its files and runs
 * Cloudflare's Vite plugin with the Worker its options describe.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { maximusProject } from '@arbol-ai/maximus/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import type { PluginConfig } from '@cloudflare/vite-plugin';
import type { WorkerConfig } from 'cf/config';
import type { Plugin } from 'vite';

import { checkWebAppBuild, projectOptions, workerConfig } from './options.ts';
import type { MaximusOptions, Phase } from './options.ts';

export type { MaximusOptions, Phase, TokenOptions, WebAppOptions } from './options.ts';

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
      if (existsSync(join(root, 'cloudflare.config.ts'))) {
        throw new TypeError(
          "maximus() configures the Worker: move cloudflare.config.ts into maximus()'s options."
        );
      }
      checkWebAppBuild(root, config);
      worker = workerConfig(root, phase, options, project.api.prepare(root, phase).crons);
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
  // would run them in workerd's dev environment, stays out.
  if (process.env.VITEST) {
    return [configure, project];
  }
  // Cloudflare's plugin parses what the customizer returns with its input schema, as it parses
  // cloudflare.config.ts; its type names the parsed form.
  const customize = () => worker as Exclude<PluginConfig['config'], (...args: never[]) => unknown>;
  return [configure, project, ...cloudflare({ config: customize })];
}
