/**
 * `maximus init`: a new service or project from the starter templates, with every placeholder replaced, a
 * development token only its owner can read, agent guides linked to the project's own, and the names and
 * directories it refuses before writing anything.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, expect, test } from 'vite-plus/test';

import { scaffold } from '../../src/tooling/internal/scaffold.ts';

/** The release that scaffolds, which a new project depends on. */
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as {
  version: string;
};
/** The name refusal, for every name that is not lowercase kebab-case of 2 to 41 characters. */
const BAD_NAME = 'Use a lowercase kebab-case project name of 2 to 41 characters.';

const parents: string[] = [];

/** A directory that does not exist yet, in a temporary parent removed after the test. */
function newDirectory(name = 'tasks'): string {
  const parent = mkdtempSync(join(tmpdir(), 'maximus-init-'));
  parents.push(parent);
  return join(parent, name);
}

afterEach(() => {
  for (const parent of parents.splice(0)) {
    rmSync(parent, { recursive: true, force: true });
  }
});

/** Every file and link below `directory`, relative to `root`; links are listed, never followed. */
function entries(root: string, directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? entries(root, path) : [relative(root, path)];
  });
}

/** Every file and link of the new project, sorted. */
function listing(root: string): string[] {
  return entries(root, root).toSorted();
}

/** A file of the new project as text. */
function read(root: string, file: string): string {
  return readFileSync(join(root, file), 'utf-8');
}

/** Today's date as the starter's compatibility date writes it, on either side of the scaffold. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

test('init writes the service starter, with the name, entrypoint, release and date in every placeholder', () => {
  const directory = newDirectory('billing-api');
  const before = today();
  const result = scaffold(directory, 'billing-api');
  const after = today();
  expect(result).toMatchObject({ directory, layout: 'service' });
  expect(result.next).toContain('call it with the DEVELOPMENT_TOKEN in .dev.vars');
  expect(listing(directory)).toEqual([
    '.agents/skills/project/SKILL.md',
    '.claude/skills/project',
    '.codex/skills/project',
    '.dev.vars',
    '.github/workflows/ci.yml',
    '.gitignore',
    'AGENTS.md',
    'CLAUDE.md',
    'README.md',
    'cloudflare.config.ts',
    'package.json',
    'src/app.ts',
    'src/index.ts',
    'tests/contract.test.ts',
    'tsconfig.json',
    'vite.config.ts',
    'vitest.config.ts',
  ]);
  for (const file of listing(directory)) {
    if (!lstatSync(join(directory, file)).isSymbolicLink()) {
      expect(read(directory, file), file).not.toMatch(/__[A-Z_]+__/);
    }
  }
  const manifest = JSON.parse(read(directory, 'package.json')) as {
    name: string;
    dependencies: Record<string, string>;
  };
  expect(manifest.name).toBe('billing-api');
  expect(manifest.dependencies['@arbol-ai/maximus']).toBe(version);
  expect(read(directory, 'src/index.ts')).toContain('export const BillingApiService = worker.entrypoint;');
  expect(read(directory, 'src/app.ts')).toContain("namespace: 'billing-api',");
  expect(read(directory, 'src/app.ts')).toContain("origin: 'https://billing-api.example.com',");
  const date = /compatibilityDate: '(\d{4}-\d{2}-\d{2})'/.exec(read(directory, 'cloudflare.config.ts'))?.[1];
  expect([before, after]).toContain(date);
});

test('.dev.vars holds a fresh 32-byte development token only its owner can read, and Git ignores it', () => {
  const first = newDirectory();
  const second = newDirectory();
  scaffold(first, 'tasks');
  scaffold(second, 'tasks');
  const token = /^DEVELOPMENT_TOKEN=([0-9a-f]{64})\n$/.exec(read(first, '.dev.vars'))?.[1];
  expect(token).toBeDefined();
  expect(statSync(join(first, '.dev.vars')).mode & 0o777).toBe(0o600);
  expect(read(second, '.dev.vars')).not.toContain(token);
  expect(read(first, '.gitignore').split('\n')).toContain('.dev.vars*');
});

test("AGENTS.md and each harness's skill folder link to the project's own guide and skill", () => {
  const directory = newDirectory();
  scaffold(directory, 'tasks');
  expect(lstatSync(join(directory, 'AGENTS.md')).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(directory, 'AGENTS.md'))).toBe('CLAUDE.md');
  expect(read(directory, 'AGENTS.md')).toBe(read(directory, 'CLAUDE.md'));
  for (const harness of ['.claude', '.codex']) {
    expect(readlinkSync(join(directory, harness, 'skills/project')), harness).toBe(
      '../../.agents/skills/project'
    );
    expect(read(directory, `${harness}/skills/project/SKILL.md`), harness).toContain(
      'name: tasks-development'
    );
  }
});

test('the project layout trades src/, tests and cloudflare.config.ts for conventions vite.config.ts configures', () => {
  const directory = newDirectory();
  const before = today();
  const result = scaffold(directory, 'tasks', 'project');
  const after = today();
  expect(result).toMatchObject({ directory, layout: 'project' });
  expect(result.next).toContain('The public home page says Hello World.');
  expect(listing(directory)).toEqual([
    '.agents/skills/project/SKILL.md',
    '.claude/skills/project',
    '.codex/skills/project',
    '.dev.vars',
    '.github/workflows/ci.yml',
    '.gitignore',
    'AGENTS.md',
    'CLAUDE.md',
    'README.md',
    'middleware/10-response.ts',
    'package.json',
    'pages/index.ts',
    'routes/v1/greeting.get.ts',
    'routes/v1/greeting.post.ts',
    'tsconfig.json',
    'vite.config.ts',
  ]);
  // A file both starters have is the project's own.
  expect(read(directory, 'vite.config.ts')).toContain("origin: 'https://tasks.example.com',");
  expect([before, after]).toContain(
    /compatibilityDate: '(\d{4}-\d{2}-\d{2})'/.exec(read(directory, 'vite.config.ts'))?.[1]
  );
  const manifest = JSON.parse(read(directory, 'package.json')) as {
    devDependencies: Record<string, string>;
  };
  expect(manifest.devDependencies['@arbol-ai/vite-plugin']).toBe(version);
  expect(read(directory, '.gitignore').split('\n')).toContain('.maximus/');
  expect(read(directory, '.agents/skills/project/SKILL.md')).toContain(
    'Extend the tasks Maximus backend using its optional file conventions.'
  );
  expect(read(directory, 'routes/v1/greeting.get.ts')).toContain('the scope is tasks:greeting:read');
});

test('init refuses a name that is not lowercase kebab-case of 2 to 41 characters, before writing anything', () => {
  for (const name of [
    'a',
    'Tasks',
    'tasks_api',
    'tasks api',
    '-tasks',
    'tasks-',
    'tasks--api',
    '1tasks',
    'a'.repeat(42),
  ]) {
    const directory = newDirectory();
    expect(() => scaffold(directory, name), name).toThrow(new TypeError(BAD_NAME));
    expect(existsSync(directory), name).toBe(false);
  }
  for (const name of ['ab', `a${'b'.repeat(40)}`]) {
    const directory = newDirectory();
    scaffold(directory, name);
    expect((JSON.parse(read(directory, 'package.json')) as { name: string }).name).toBe(name);
  }
});

test('init never overwrites: an existing directory, even an empty one, is refused and left as it was', () => {
  const existing = newDirectory();
  mkdirSync(existing);
  writeFileSync(join(existing, 'notes.txt'), 'keep me');
  const empty = newDirectory();
  mkdirSync(empty);
  for (const directory of [existing, empty]) {
    expect(() => scaffold(directory, 'tasks')).toThrow(
      'Choose a new directory; existing projects are never overwritten.'
    );
  }
  expect(readdirSync(existing)).toEqual(['notes.txt']);
  expect(read(existing, 'notes.txt')).toBe('keep me');
  expect(readdirSync(empty)).toEqual([]);
});
