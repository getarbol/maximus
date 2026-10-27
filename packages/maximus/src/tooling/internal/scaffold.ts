/**
 * `maximus init`: a new project from the starter template, with the MCP server (unless asked not to) and
 * the web app (when asked to) laid over it, a development token only its owner can read, and the agent
 * skills linked where coding agents look for them.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { linkAgentSkills } from './agent-skills.ts';

/** What a new project holds besides the API: the MCP server, on by default, and a web app. */
export interface ScaffoldOptions {
  /** Whether a route is also an MCP tool and `mcp/instructions.md` describes the server; true by default. */
  mcp?: boolean;
  /** Whether the project is a web app, with `index.html` and React pages in `app/`; false by default. */
  web?: boolean;
}

/** A starter layer: its template directory and the files of the layers below that it removes. */
interface Layer {
  template: string;
  removes: readonly string[];
}

/**
 * The Maximus package's own directory: the nearest one above this module with a package.json. The build
 * bundles this module into the CLI, so its depth below the package differs from the source's.
 */
export function packageDirectory(): string {
  let directory = import.meta.dirname;
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error('Found no package.json above the Maximus CLI.');
    }
    directory = parent;
  }
  return directory;
}

/** Whether a value is a plain JSON object, which a layer's JSON merges into the one below it. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A layer's JSON over the one below it: objects merged field by field, lists joined without repeats. */
function mergeJson(base: unknown, layer: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(layer)) {
    return [...new Set([...base, ...layer])];
  }
  if (isObject(base) && isObject(layer)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(layer)) {
      merged[key] = key in base ? mergeJson(base[key], value) : value;
    }
    return merged;
  }
  return layer;
}

/** The fields of a package.json whose keys are package names, which formatters keep sorted. */
const DEPENDENCIES = new Set(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']);

/**
 * JSON as the project's formatter writes it: objects one field per line, a list of scalars on one line when
 * it fits in 110 columns, and dependency maps in name order.
 */
function formatJson(value: unknown, indent = '', key = ''): string {
  if (Array.isArray(value)) {
    const items = value.map((item) => formatJson(item, `${indent}  `));
    const inline = `[${items.join(', ')}]`;
    return value.every((item) => typeof item !== 'object' || item === null) &&
      indent.length + key.length + inline.length <= 106
      ? inline
      : `[\n${items.map((item) => `${indent}  ${item}`).join(',\n')}\n${indent}]`;
  }
  if (isObject(value)) {
    const entries = DEPENDENCIES.has(key)
      ? Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : Number(a > b)))
      : Object.entries(value);
    if (!entries.length) {
      return '{}';
    }
    const fields = entries.map(
      ([name, child]) => `${indent}  ${JSON.stringify(name)}: ${formatJson(child, `${indent}  `, name)}`
    );
    return `{\n${fields.join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

/** Every template file of a layer, by the path it takes in the project. */
function templateFiles(template: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const file of readdirSync(template, { recursive: true, withFileTypes: true })) {
    if (file.isFile() && file.name.endsWith('.template')) {
      const source = resolve(file.parentPath, file.name);
      files.set(relative(template, source).replace(/\.template$/, ''), source);
    }
  }
  return files;
}

/**
 * Writes a new project from the starter template into a directory that does not exist yet: the API, the MCP
 * server unless `mcp` is false, and a web app when `web` is true.
 */
export function scaffold(directory: string, name: string, options: ScaffoldOptions = {}) {
  // One kebab-case name serves as the package, the Worker and the scope namespace.
  if (!/^(?=.{2,41}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
    throw new TypeError('Use a lowercase kebab-case project name of 2 to 41 characters.');
  }
  const root = resolve(directory);
  if (existsSync(root)) {
    throw new Error('Choose a new directory; existing projects are never overwritten.');
  }
  const own = packageDirectory();
  // A new project starts on the release that scaffolds it.
  const { version } = JSON.parse(readFileSync(join(own, 'package.json'), 'utf-8')) as { version: string };
  const values: Record<string, string> = {
    __PROJECT_NAME__: name,
    __MAXIMUS_VERSION__: version,
    __COMPATIBILITY_DATE__: new Date().toISOString().slice(0, 10),
  };
  const layers: Layer[] = [
    { template: 'project', removes: [] },
    ...(options.mcp === false ? [] : [{ template: 'mcp', removes: [] }]),
    // index.html's app answers `/`, which the API starter's public page answered.
    ...(options.web ? [{ template: 'web', removes: ['pages/index.ts'] }] : []),
  ];
  const files = new Map<string, string>();
  for (const { template, removes } of layers) {
    for (const path of removes) {
      files.delete(path);
    }
    for (const [path, source] of templateFiles(join(own, 'templates', template))) {
      let text = readFileSync(source, 'utf-8');
      for (const [placeholder, value] of Object.entries(values)) {
        text = text.replaceAll(placeholder, value);
      }
      const below = files.get(path);
      files.set(
        path,
        below !== undefined && path.endsWith('.json')
          ? `${formatJson(mergeJson(JSON.parse(below), JSON.parse(text)))}\n`
          : text
      );
    }
  }
  for (const [path, text] of files) {
    const target = resolve(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, { flag: 'wx' });
  }
  // The development token `vp dev` accepts from localhost, readable only by its owner. The starter's
  // .gitignore keeps `.dev.vars` out of Git, and only `vp dev` declares the binding.
  writeFileSync(resolve(root, '.dev.vars'), `DEVELOPMENT_TOKEN=${randomBytes(32).toString('hex')}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  symlinkSync('CLAUDE.md', resolve(root, 'AGENTS.md'));
  for (const harness of ['.claude', '.codex']) {
    mkdirSync(resolve(root, harness, 'skills'), { recursive: true });
    symlinkSync('../../.agents/skills/project', resolve(root, harness, 'skills/project'));
  }
  const skills = linkAgentSkills(root);
  return {
    directory: root,
    mcp: options.mcp !== false,
    web: options.web === true,
    skills,
    next: 'Run bun install and bun run dev. Set origin and tokens.issuer in vite.config.ts before the first deployment; bun run verify runs the types, lint, tests and build, and bun run deploy deploys.',
  };
}
