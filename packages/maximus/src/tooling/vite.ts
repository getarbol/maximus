/** Optional Vite integration. It generates static imports before Cloudflare reads the Worker. */
import { relative, resolve } from 'node:path';

import type { Plugin } from 'vite';

import { prepareProject } from './internal/prepare-project.ts';
import { PROJECT_DIRECTORIES } from './internal/project-files.ts';

/** Prepare on startup/build and refresh discovery when convention files are added or removed. */
export function maximusProject(): Plugin {
  let root = process.cwd();
  let mode = 'production';
  return {
    name: 'maximus-project',
    enforce: 'pre',
    config(config, environment) {
      root = resolve(config.root ?? root);
      ({ mode } = environment);
      prepareProject(root, mode);
    },
    configureServer(server) {
      const update = (file: string) => {
        const [directory] = relative(root, file).split(/[\\/]/);
        if (!PROJECT_DIRECTORIES.some((name) => name === directory)) {
          return;
        }
        try {
          prepareProject(root, mode);
          server.ws.send({ type: 'full-reload' });
        } catch (error) {
          server.config.logger.error(error instanceof Error ? error.message : String(error));
          server.ws.send({
            type: 'error',
            err: { message: error instanceof Error ? error.message : String(error), stack: '' },
          });
        }
      };
      server.watcher.on('add', update).on('unlink', update);
      server.httpServer?.once('close', () => {
        server.watcher.off('add', update).off('unlink', update);
      });
    },
  };
}
