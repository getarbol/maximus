/**
 * Temporary projects for the tooling tests: their files, what `vite.config.ts` states for them as the plugin
 * derives it, and the modules `maximus prepare` writes. Each test file removes its projects after each test
 * with `removeProjects`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { prepareProject } from '../../src/tooling/internal/prepare-project.ts';
import type { ProjectOptions } from '../../src/tooling/internal/prepare-project.ts';

const directories: string[] = [];

/** A new empty directory below `parent`, removed by `removeProjects`. */
export function temporary(parent = tmpdir()): string {
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'maximus-'));
  directories.push(directory);
  return directory;
}

/** Creates or replaces files of a project. */
export function write(root: string, files: Readonly<Record<string, string>>): void {
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), contents);
  }
}

/** A project in a new temporary directory, with these files. */
export function project(files: Readonly<Record<string, string>> = {}, parent?: string): string {
  const root = temporary(parent);
  write(root, files);
  return root;
}

/** Removes every directory the test created. */
export function removeProjects(): void {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * What `vite.config.ts` states for a tasks service, as the plugin derives it: a web app when `web` is set,
 * with the bindings of each mode.
 */
export function options(
  overrides: { web?: boolean; basePath?: string; env?: ProjectOptions['env'] } = {}
): ProjectOptions {
  return {
    application: {
      name: 'tasks',
      namespace: 'tasks',
      title: 'Tasks',
      version: '1.0.0',
      origin: 'https://tasks.example.test',
      tokens: { issuer: 'https://issuer.example.test/', audience: 'https://tasks.example.test' },
      rpc: { callers: [] },
    },
    worker: {
      http: { basePath: overrides.basePath ?? '/api', healthPath: '/health' },
      ...(overrides.web ? { assets: { binding: 'ASSETS' } } : {}),
    },
    env: overrides.env ?? { production: {}, development: {} },
  };
}

/** Prepares a project as the plugin would, for a mode, with the options of a tasks service by default. */
export function prepare(root: string, mode = 'production', configured: ProjectOptions = options()) {
  return prepareProject(root, mode, configured);
}

/** A generated module as text. */
export function generated(root: string, name: string): string {
  return readFileSync(join(root, '.maximus', name), 'utf-8');
}

/** A route file's default export, as a project writes it. */
export const ROUTE = 'export default defineHandler(() => ({}));';
