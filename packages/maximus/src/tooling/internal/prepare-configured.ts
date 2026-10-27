/**
 * `maximus prepare` for any layout: a project configured in `vite.config.ts` is prepared by its plugin, as a
 * build would, so the command and the build generate the same modules.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { prepareProject } from './prepare-project.ts';

/** A configuration's plugins, as Vite flattens them from nested lists and promises. */
async function pluginsOf(option: unknown): Promise<unknown[]> {
  const resolved: unknown = await option;
  if (!Array.isArray(resolved)) {
    return [resolved];
  }
  const nested = await Promise.all(resolved.map(pluginsOf));
  return nested.flat();
}

/** The configuration files Vite reads, in the order it looks for them. */
const VITE_CONFIGS = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs'];

/**
 * Prepares the project at `directory`. Without `maximus.config.ts` or the 7.3 `src/` entries, it loads
 * `vite.config.ts` with Vite, which evaluates it as every `vp` command does, and prepares the project
 * through the plugin it configures; application modules are only parsed.
 */
export async function prepareConfiguredProject(directory: string, mode = 'production') {
  const root = resolve(directory);
  const configured = ['maximus.config.ts', 'maximus.config.mts', 'maximus.config.js', 'maximus.config.mjs'];
  const viteConfig = VITE_CONFIGS.find((name) => existsSync(join(root, name)));
  if (
    !viteConfig ||
    configured.some((name) => existsSync(join(root, name))) ||
    (existsSync(join(root, 'src/application.ts')) && existsSync(join(root, 'src/worker.ts')))
  ) {
    return prepareProject(root, mode);
  }
  const { loadConfigFromFile } = await import('vite');
  const loaded = await loadConfigFromFile({ command: 'build', mode }, join(root, viteConfig), root);
  for (const plugin of await pluginsOf(loaded?.config.plugins)) {
    if (plugin && typeof plugin === 'object' && 'name' in plugin && plugin.name === 'maximus-project') {
      const api: unknown = 'api' in plugin ? plugin.api : undefined;
      if (api && typeof api === 'object' && 'prepare' in api && typeof api.prepare === 'function') {
        return (api.prepare as typeof prepareProject)(root, mode);
      }
    }
  }
  return prepareProject(root, mode);
}
