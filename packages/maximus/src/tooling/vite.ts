/**
 * `@arbol-ai/maximus/vite`: the Vite plugin that keeps `.maximus/` in step with a project's files, which
 * `@arbol-ai/vite-plugin` composes with Cloudflare's. Applications configure `maximus()` from that package.
 */
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import type { Plugin } from 'vite';

import { prepareProject } from './internal/prepare-project.ts';
import type { PreparedProject, ProjectOptions } from './internal/prepare-project.ts';
import { PROJECT_DIRECTORIES } from './internal/project-files.ts';

export type { PreparedProject, ProjectOptions } from './internal/prepare-project.ts';

/** A web app's pages and layout, and the files its build serves by name. */
const WEB_APP_DIRECTORIES = ['app', 'public'] as const;
/** The root modules that complete the application, and the web app's HTML entry. */
const ROOT_MODULE = /^(?:(?:errors|auth|context)\.(?:ts|mts|js|mjs)|index\.html)$/;

/** What the plugin derives from `vite.config.ts` for a project's root and a Vite mode. */
export type ProjectOptionsSource = (root: string, mode: string) => ProjectOptions;
/** What the plugin offers the `maximus prepare` command, which loads `vite.config.ts` to find it. */
export interface ProjectApi {
  /** Prepares the project at `root` for a mode, as a build would. */
  prepare: (root: string, mode: string) => PreparedProject;
}

/**
 * Prepares the project before every build and before Vite reloads source modules during development, and
 * asks for a restart when the Worker itself changes: a web app appears or goes, or a Durable Object does.
 */
export function maximusProject(project: ProjectOptionsSource): Plugin<ProjectApi> & { api: ProjectApi } {
  let root = process.cwd();
  let mode = 'production';
  let previous: PreparedProject | undefined;
  const prepare = (directory: string, preparing: string) =>
    prepareProject(directory, preparing, project(resolve(directory), preparing));
  const reconcile = () => {
    const current = prepare(root, mode);
    const restart =
      previous !== undefined &&
      (previous.webApp !== current.webApp ||
        previous.durableObjects.join('\n') !== current.durableObjects.join('\n'));
    previous = current;
    return { ...current, restart };
  };
  const isProjectFile = (file: string) => {
    const [first = '', ...rest] = relative(root, file).split(/[\\/]/);
    return (
      [...PROJECT_DIRECTORIES, ...WEB_APP_DIRECTORIES].some((name) => name === first) ||
      (rest.length === 0 && ROOT_MODULE.test(first))
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
