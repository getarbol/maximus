/**
 * `maximus init`: a new project from the starter template.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';

/**
 * The Maximus package's own directory: the nearest one above this module with a package.json. The
 * build bundles this module into the CLI, so its depth below the package differs from the source's.
 */
function packageDirectory(): string {
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

/**
 * `maximus init`: writes a new project from the starter template into a directory that does not exist yet.
 */
export function scaffold(directory: string, name: string) {
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
  const template = join(own, 'templates', 'project');
  for (const file of readdirSync(template, { recursive: true, withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.template')) {
      continue;
    }
    const source = resolve(file.parentPath, file.name);
    const target = resolve(root, relative(template, source).replace(/\.template$/, ''));
    mkdirSync(dirname(target), { recursive: true });
    let text = readFileSync(source, 'utf-8');
    for (const [placeholder, value] of Object.entries(values)) {
      text = text.replaceAll(placeholder, value);
    }
    writeFileSync(target, text, { flag: 'wx' });
  }
  // The development token `vp dev` accepts from localhost, readable only by its owner. The starter's
  // .gitignore keeps `.dev.vars` out of Git, and only its development build declares the binding.
  writeFileSync(resolve(root, '.dev.vars'), `DEVELOPMENT_TOKEN=${randomBytes(32).toString('hex')}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  symlinkSync('CLAUDE.md', resolve(root, 'AGENTS.md'));
  for (const harness of ['.claude', '.codex']) {
    mkdirSync(resolve(root, harness, 'skills'), { recursive: true });
    symlinkSync('../../.agents/skills/project', resolve(root, harness, 'skills/project'));
  }
  return {
    directory: root,
    next: 'Run bun install and bun run dev. The public home page says Hello World. Configure the origin and token policy in vite.config.ts before adding production callers. Use bun run verify for types, lint and build, then bun run deploy.',
  };
}
