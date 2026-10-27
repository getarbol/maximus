/**
 * Deterministic module discovery: only ordinary source files inside the convention directories are read, and
 * the project's commands write through no folder linked from elsewhere.
 */
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/** The convention directories prepare discovers modules in; bindings and triggers stay in vite.config.ts. */
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

/** A full recipient, `local@domain.tld`: what an email module is named after. */
const RECIPIENT = /^[^@/]+@[^@/]+\.[^@./]+$/;
/** The convention directories whose module names have no dots, so `.dev` and `.prod` alone name a mode. */
const UNDOTTED = new Set(['middleware', 'crons', 'queues']);

/**
 * Whether a `.dev`, `.prod`, `.test` or `.spec` ending is the last label of an email module's recipient,
 * `help@example.dev`, rather than a mode or test suffix: only what precedes it is no recipient.
 */
function endsRecipient(directory: string, name: string, rest: string): boolean {
  return directory === 'email' && RECIPIENT.test(name) && !RECIPIENT.test(rest);
}

/** Sort by code units so generated imports are identical on every locale and platform. */
export function compareNames(a: string, b: string): number {
  return a < b ? -1 : Number(a > b);
}

/**
 * Refuses `folder`, or a folder of the project on the way to it, that is a symlink: what a command writes
 * below it would land wherever the link leads. The project's root itself may be reached through one.
 */
export function checkProjectFolder(root: string, folder: string): void {
  let current = root;
  for (const segment of relative(root, folder).split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new TypeError(`Project directory cannot be a symlink: ${relative(root, current)}`);
    }
  }
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
      } else if (entry.isFile() && /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/.test(entry.name)) {
        const stem = relative(folder, file)
          .split(sep)
          .join('/')
          .replace(/\.[^.]+$/, '');
        const suffix = /\.(dev|prod)$/.exec(stem);
        const environment =
          suffix && !endsRecipient(directory, stem, stem.slice(0, suffix.index)) ? suffix : undefined;
        const name = environment ? stem.slice(0, environment.index) : stem;
        // Declarations, tests and specs sit beside modules without being discovered.
        const marker = /\.(d|test|spec)$/.exec(name);
        if (marker && (marker[1] === 'd' || !endsRecipient(directory, name, name.slice(0, marker.index)))) {
          continue;
        }
        // A message reaches the module named after its recipient, or `_default`: any other name never would.
        const own = name.slice(name.lastIndexOf('/') + 1);
        if (directory === 'email' && own !== '_default' && !RECIPIENT.test(own)) {
          throw new TypeError(
            `Name an email module after the recipient it handles, such as help@example.com, or _default: ${relative(root, file)}`
          );
        }
        // A dot left is a misspelled mode, such as `.development` or `.local`, which would join every mode.
        if (UNDOTTED.has(directory) && own.includes('.')) {
          throw new TypeError(
            `Name a module without dots but its mode suffix, .dev or .prod: ${relative(root, file)}`
          );
        }
        if (environment && (environment[1] === 'dev' ? mode !== 'development' : mode !== 'production')) {
          continue;
        }
        files.push({ file, name });
      }
    }
  }
  visit(folder);
  files.sort((a, b) => compareNames(a.file, b.file));
  return files;
}

/**
 * Convert groups, index files and dynamic segments into a native Maximus path, or into the React Router path
 * of a web app's page (`app/routes/tasks/[taskId].tsx` is `/tasks/:taskId`).
 */
export function projectPath(name: string, kind: 'routes' | 'pages' | 'app'): string {
  const segments = name.split('/').filter((segment) => !/^\([a-zA-Z0-9_-]+\)$/.test(segment));
  if (segments.at(-1) === 'index') {
    segments.pop();
  }
  const parts = segments.map((segment) => {
    const parameter = /^\[([a-zA-Z][a-zA-Z0-9_]*)\]$/.exec(segment)?.[1];
    if (parameter && kind !== 'pages') {
      return kind === 'routes' ? `{${parameter}}` : `:${parameter}`;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(segment)) {
      throw new TypeError(
        `Unsupported ${kind} segment: ${segment}. Pages use fixed paths; operations and app pages support [parameter].`
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

/** A route path's shape: `/v1/tasks/{taskId}` and `/v1/tasks/{id}` match the same paths. */
export function routeShape(path: string): string {
  return path.replaceAll(/\{[^}]+\}/g, '{}');
}

/**
 * The files of a web app's `public/`, which its build copies to the root as they are: the paths the Worker
 * serves them at, such as `/favicon.svg`. Dotfiles stay out; symlinks and other names are refused.
 */
export function publicFiles(root: string): string[] {
  const folder = resolve(root, 'public');
  if (!existsSync(folder)) {
    return [];
  }
  if (lstatSync(folder).isSymbolicLink()) {
    throw new TypeError('Project directory cannot be a symlink: public');
  }
  const paths: string[] = [];
  function visit(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = join(current, entry.name);
      if (entry.name.startsWith('.')) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw new TypeError(`Public files cannot be symlinks: ${relative(root, file)}`);
      }
      if (entry.isDirectory()) {
        visit(file);
      } else if (entry.isFile()) {
        const path = `/${relative(folder, file).split(sep).join('/')}`;
        if (!/^(?:\/[a-zA-Z0-9._~-]+)+$/.test(path)) {
          throw new TypeError(
            `Name public files with letters, digits, dots, underscores, tildes and hyphens: ${relative(root, file)}`
          );
        }
        paths.push(path);
      }
    }
  }
  visit(folder);
  return paths.toSorted(compareNames);
}
