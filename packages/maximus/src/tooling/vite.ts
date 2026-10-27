/** Optional Vite integration. It reconciles static imports before Cloudflare reads the Worker. */
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import type { Plugin } from 'vite';

import { prepareProject } from './internal/prepare-project.ts';
import type { ProjectOptions } from './internal/prepare-project.ts';
import { PROJECT_DIRECTORIES } from './internal/project-files.ts';

export type { ProjectOptions } from './internal/prepare-project.ts';

/** A web app's pages and layout, and the files its build serves by name. */
const WEB_APP_DIRECTORIES = ['app', 'public'] as const;

/**
 * What a plugin that configures the project in `vite.config.ts` derives for a root and a Vite mode; nothing
 * when `maximus.config.ts` or the 7.3 `src/` entries configure it.
 */
export type ProjectOptionsSource = (root: string, mode: string) => ProjectOptions | undefined;
/** What the plugin offers the `maximus prepare` command, which loads `vite.config.ts` to find it. */
export interface ProjectApi {
  /** Prepares the project at `root` for a mode, as a build would. */
  prepare: (root: string, mode: string) => ReturnType<typeof prepareProject>;
}

/**
 * Prepare before every build and before Vite invalidates source modules during development. `project`
 * derives what `vite.config.ts` configures, for a project with neither `maximus.config.ts` nor `src/`
 * entries.
 */
export function maximusProject(project?: ProjectOptionsSource): Plugin<ProjectApi> & { api: ProjectApi } {
  let root = process.cwd();
  let mode = 'production';
  let previous: ReturnType<typeof prepareProject> | undefined;
  const prepare = (directory: string, preparing: string) =>
    prepareProject(directory, preparing, project?.(resolve(directory), preparing));
  const reconcile = () => {
    const current = prepare(root, mode);
    // A new configuration, Durable Object or web app changes the Worker Cloudflare's plugin configured.
    const restart =
      previous !== undefined &&
      (previous.config !== current.config ||
        previous.webApp !== current.webApp ||
        previous.durableObjects.join('\n') !== current.durableObjects.join('\n'));
    previous = current;
    return { ...current, restart };
  };
  const isProjectFile = (file: string) => {
    const path = relative(root, file).split(/[\\/]/);
    return (
      [...PROJECT_DIRECTORIES, ...WEB_APP_DIRECTORIES].some((name) => name === path[0]) ||
      (path.length === 1 &&
        (/^(?:maximus\.config|errors|auth|context)\.(?:ts|mts|js|mjs)$/.test(path[0] ?? '') ||
          path[0] === 'index.html')) ||
      (path[0] === 'src' && ['application.ts', 'worker.ts'].includes(path[1] ?? ''))
    );
  };
  return {
    name: 'maximus-project',
    enforce: 'pre',
    api: { prepare },
    config(config, environment) {
      root = resolve(config.root ?? root);
      ({ mode } = environment);
      reconcile();
    },
    buildStart() {
      const current = reconcile();
      // Watching the project root would also observe generated output and can loop in build --watch.
      for (const file of current.files) {
        this.addWatchFile(file);
      }
      if (current.config) {
        this.addWatchFile(resolve(root, current.config));
      }
      for (const directory of [...PROJECT_DIRECTORIES, ...WEB_APP_DIRECTORIES]) {
        const path = resolve(root, directory);
        if (existsSync(path)) {
          this.addWatchFile(path);
        }
      }
    },
    hotUpdate: {
      order: 'pre',
      async handler({ file, server }) {
        if (!isProjectFile(file)) {
          return;
        }
        // This hook receives create/update/delete before affected Worker modules are reloaded.
        // Throwing reports the discovery failure through Vite instead of loading a stale graph.
        const current = reconcile();
        if (current.restart) {
          await server.restart();
          return [];
        }
        if (current.changed) {
          this.environment.hot.send({ type: 'full-reload' });
        }
      },
    },
  };
}
