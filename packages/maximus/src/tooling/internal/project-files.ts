/** Deterministic source discovery. Only ordinary source files inside opted-in directories are loaded. */
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/** Project-owned convention directories; infrastructure remains in cloudflare.config.ts. */
export const PROJECT_DIRECTORIES = [
  'routes',
  'mcp',
  'pages',
  'middleware',
  'crons',
  'queues',
  'email',
  'durable-objects',
] as const;

/** A source module's physical location and its convention name, without mode and source suffixes. */
export interface ProjectFile {
  file: string;
  name: string;
}

/** Sort by code units so generated imports are identical on every locale and platform. */
export function compareNames(a: string, b: string): number {
  return a < b ? -1 : Number(a > b);
}

/** Discover without following symlinks or importing user code into the build host. */
export function projectFiles(root: string, directory: string, mode: string): ProjectFile[] {
  const folder = resolve(root, directory);
  if (!existsSync(folder)) {
    return [];
  }
  if (lstatSync(folder).isSymbolicLink()) {
    throw new TypeError(`Project directory cannot be a symlink: ${directory}`);
  }
  const files: ProjectFile[] = [];
  function visit(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (
        entry.name.startsWith('.') ||
        (entry.name.startsWith('_') && !(directory === 'email' && entry.name.startsWith('_default.')))
      ) {
        continue;
      }
      const file = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new TypeError(`Project modules cannot be symlinks: ${relative(root, file)}`);
      }
      if (entry.isDirectory()) {
        visit(file);
      } else if (
        entry.isFile() &&
        /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/.test(entry.name) &&
        !/\.(?:d|test|spec)(?:\.(?:dev|prod))?\.[^.]+$/.test(entry.name)
      ) {
        const name = relative(folder, file)
          .split(sep)
          .join('/')
          .replace(/\.[^.]+$/, '');
        const environment = /\.(dev|prod)$/.exec(name)?.[1];
        if (environment && (environment === 'dev' ? mode !== 'development' : mode !== 'production')) {
          continue;
        }
        files.push({ file, name: name.replace(/\.(?:dev|prod)$/, '') });
      }
    }
  }
  visit(folder);
  files.sort((a, b) => compareNames(a.file, b.file));
  return files;
}

/** Convert groups, index files and dynamic operation segments into a native Maximus path. */
export function projectPath(name: string, kind: 'routes' | 'pages'): string {
  const segments = name.split('/').filter((segment) => !/^\([a-zA-Z0-9_-]+\)$/.test(segment));
  if (segments.at(-1) === 'index') {
    segments.pop();
  }
  const parts = segments.map((segment) => {
    const parameter = /^\[([a-zA-Z][a-zA-Z0-9_]*)\]$/.exec(segment)?.[1];
    if (parameter && kind === 'routes') {
      return `{${parameter}}`;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(segment)) {
      throw new TypeError(
        `Unsupported ${kind} segment: ${segment}. Pages use fixed paths; operations support [parameter].`
      );
    }
    return segment;
  });
  const path = `/${parts.join('/')}`;
  if (kind === 'routes' && !/^\/v[1-9][0-9]*\/.+/.test(path)) {
    throw new TypeError(`Operation file must live below routes/v1/ (or another version): ${name}`);
  }
  return path;
}
