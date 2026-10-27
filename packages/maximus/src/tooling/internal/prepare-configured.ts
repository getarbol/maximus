/**
 * `maximus prepare`: the project is prepared by the plugin its `vite.config.ts` configures, as a build would,
 * so the command and the build generate the same modules.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { ProjectApi } from '../vite.ts';

/** A configuration's plugins, as Vite flattens them from nested lists and promises. */
async function pluginsOf(option: unknown): Promise<unknown[]> {
  const resolved: unknown = await option;
  if (!Array.isArray(resolved)) {
    return [resolved];
  }
  const nested = await Promise.all(resolved.map(pluginsOf));
  return nested.flat();
}

/** The configuration files Vite reads, in the order it looks for them: the first it finds is the one it loads. */
const VITE_CONFIGS = [
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.ts',
  'vite.config.cjs',
  'vite.config.mts',
  'vite.config.cts',
];

/** The API of the Maximus plugin among a configuration's plugins, if it has one. */
function projectApi(plugin: unknown): ProjectApi | undefined {
  if (plugin && typeof plugin === 'object' && 'name' in plugin && plugin.name === 'maximus-project') {
    const api: unknown = 'api' in plugin ? plugin.api : undefined;
    if (api && typeof api === 'object' && 'prepare' in api && typeof api.prepare === 'function') {
      return api as ProjectApi;
    }
  }
  return undefined;
}

/**
 * Prepares the project at `directory`: loads its `vite.config.ts` with Vite, which evaluates it as every
 * `vp` command does, and prepares it through the `maximus()` plugin it configures. Application modules are
 * only parsed.
 */
export async function prepareConfiguredProject(
  directory: string,
  mode: 'development' | 'production' = 'production'
) {
  const root = resolve(directory);
  const viteConfig = VITE_CONFIGS.find((name) => existsSync(join(root, name)));
  if (!viteConfig) {
    throw new TypeError('Configure the project in vite.config.ts with maximus() from @arbol-ai/vite-plugin.');
  }
  const { loadConfigFromFile } = await import('vite');
  const loaded = await loadConfigFromFile({ command: 'build', mode }, join(root, viteConfig), root);
  for (const plugin of await pluginsOf(loaded?.config.plugins)) {
    const api = projectApi(plugin);
    if (api) {
      return api.prepare(root, mode);
    }
  }
  throw new TypeError(`${viteConfig} configures no maximus() plugin from @arbol-ai/vite-plugin.`);
}
