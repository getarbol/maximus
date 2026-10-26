/** Optional Vite integration. It reconciles static imports before Cloudflare reads the Worker. */
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import type { Plugin } from 'vite';

import { prepareProject } from './internal/prepare-project.ts';
import { PROJECT_DIRECTORIES } from './internal/project-files.ts';

/** Prepare before every build and before Vite invalidates source modules during development. */
export function maximusProject(): Plugin {
  let root = process.cwd();
  let mode = 'production';
  let previous: ReturnType<typeof prepareProject> | undefined;
  const reconcile = () => {
    const current = prepareProject(root, mode);
    const restart =
      previous !== undefined &&
      (previous.config !== current.config ||
        previous.durableObjects.join('\n') !== current.durableObjects.join('\n'));
    previous = current;
    return { ...current, restart };
  };
  const isProjectFile = (file: string) => {
    const path = relative(root, file).split(/[\\/]/);
    return (
      PROJECT_DIRECTORIES.some((name) => name === path[0]) ||
      (path.length === 1 && /^maximus\.config\.(?:ts|mts|js|mjs)$/.test(path[0] ?? '')) ||
      (path[0] === 'src' && ['application.ts', 'worker.ts'].includes(path[1] ?? ''))
    );
  };
  return {
    name: 'maximus-project',
    enforce: 'pre',
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
      for (const directory of PROJECT_DIRECTORIES) {
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
