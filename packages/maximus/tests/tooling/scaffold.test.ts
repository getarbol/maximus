/**
 * `maximus init`: a new project from the starter's layers (the API, the MCP server unless left out, the web
 * app when asked for), with every placeholder replaced, JSON merged as the formatter writes it, a development
 * token only its owner can read, the agent guides and the Maximus skill linked, and the names and directories
 * it refuses before writing anything.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';

import { afterEach, expect, test } from 'vite-plus/test';

import { scaffold } from '../../src/tooling/internal/scaffold.ts';
import { removeProjects, temporary } from './fixtures.ts';

/** The release that scaffolds, which a new project depends on. */
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as {
  version: string;
};
/** The name refusal, for every name that is not lowercase kebab-case of 2 to 41 characters. */
const BAD_NAME = 'Use a lowercase kebab-case project name of 2 to 41 characters.';

afterEach(removeProjects);

/** A directory that does not exist yet, in a temporary parent. */
function newDirectory(name = 'tasks'): string {
  return join(temporary(), name);
}

/** Every file and link below `directory`, relative to `root`; links are listed, never followed. */
function entries(root: string, directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() && !entry.isSymbolicLink() ? entries(root, path) : [relative(root, path)];
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

/** Today's date as the starter's compatibility date writes it. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The files every starter has, whatever its layers. */
const COMMON = [
  '.agents/skills/maximus',
  '.agents/skills/project/SKILL.md',
  '.claude/skills/maximus',
  '.claude/skills/project',
  '.codex/skills/maximus',
  '.codex/skills/project',
  '.dev.vars',
  '.github/workflows/ci.yml',
  '.gitignore',
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
];

test('init writes the API with its MCP server, with the name, release and date in every placeholder', () => {
  const directory = newDirectory('billing-api');
  const before = today();
  const result = scaffold(directory, 'billing-api');
  const after = today();
  expect(result).toMatchObject({ directory, mcp: true, web: false });
  expect(result.next).toContain('bun run verify');
  expect(listing(directory)).toEqual(
    [
      ...COMMON,
      'mcp/instructions.md',
      'middleware/10-response.ts',
      'package.json',
      'pages/index.ts',
      'routes/v1/greeting.get.ts',
      'routes/v1/greeting.post.ts',
      'tests/greeting.test.ts',
      'tests/mcp.test.ts',
      'tsconfig.json',
      'vite.config.ts',
    ].toSorted()
  );
  for (const file of listing(directory)) {
    if (!lstatSync(join(directory, file)).isSymbolicLink()) {
      expect(read(directory, file), file).not.toMatch(/__[A-Z_]+__/);
    }
  }
  const manifest = JSON.parse(read(directory, 'package.json')) as {
    name: string;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
  };
  expect(manifest.name).toBe('billing-api');
  expect(manifest.dependencies['@arbol-ai/maximus']).toBe(version);
  // One package: the Vite plugin is its vite entry.
  expect(Object.keys(manifest.devDependencies)).not.toContain('@arbol-ai/vite-plugin');
  expect(read(directory, 'vite.config.ts')).toContain("import { maximus } from '@arbol-ai/maximus/vite';");
  expect(manifest.scripts.verify).toContain('bun run test');
  expect(read(directory, 'vite.config.ts')).toContain("origin: 'https://billing-api.example.com',");
  expect([before, after]).toContain(
    /compatibilityDate: '(\d{4}-\d{2}-\d{2})'/.exec(read(directory, 'vite.config.ts'))?.[1]
  );
  // The MCP layer's route replaces the API's own: the greeting is also a tool.
  expect(read(directory, 'routes/v1/greeting.get.ts')).toContain("mcp: { name: 'get_greeting' }");
  expect(read(directory, 'routes/v1/greeting.get.ts')).toContain('billing-api:greeting:read');
});

test('init without MCP writes the API alone, and with a web app replaces the public page with React pages', () => {
  const api = newDirectory();
  expect(scaffold(api, 'tasks', { mcp: false })).toMatchObject({ mcp: false, web: false });
  expect(existsSync(join(api, 'mcp'))).toBe(false);
  expect(existsSync(join(api, 'tests/mcp.test.ts'))).toBe(false);
  expect(read(api, 'routes/v1/greeting.get.ts')).not.toContain('mcp');

  const web = newDirectory();
  expect(scaffold(web, 'tasks', { web: true })).toMatchObject({ mcp: true, web: true });
  expect(existsSync(join(web, 'pages/index.ts'))).toBe(false);
  for (const file of ['index.html', 'app/main.tsx', 'app/root.tsx', 'app/routes/index.tsx']) {
    expect(existsSync(join(web, file)), file).toBe(true);
  }
  expect(read(web, 'vite.config.ts')).toContain('react(),');
  // The web layer's JSON merges into the API's, sorted and laid out as the formatter writes it.
  const manifest = read(web, 'package.json');
  expect(JSON.parse(manifest)).toMatchObject({
    dependencies: { react: '19.3.1', 'react-router': '8.5.0', '@arbol-ai/maximus': version },
    devDependencies: { '@vitejs/plugin-react': '6.1.2', 'vite-plus': '1.4.0' },
  });
  const devDependencies = Object.keys((JSON.parse(manifest) as { devDependencies: object }).devDependencies);
  expect(devDependencies).toEqual(devDependencies.toSorted());
  const tsconfig = read(web, 'tsconfig.json');
  expect(tsconfig).toContain('"lib": ["ES2024", "DOM", "DOM.Iterable"],');
  expect(tsconfig).toContain('"jsx": "react-jsx"');
  expect(tsconfig).toContain('    "app"\n');
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
  expect(read(first, '.gitignore').split('\n')).toEqual(expect.arrayContaining(['.dev.vars*', '.maximus/']));
});

test("AGENTS.md and each agent's skills link to the project's own guide and the installed Maximus skill", () => {
  const directory = newDirectory();
  expect(scaffold(directory, 'tasks').skills).toEqual([
    '.agents/skills/maximus',
    '.claude/skills/maximus',
    '.codex/skills/maximus',
  ]);
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
  for (const harness of ['.agents', '.claude', '.codex']) {
    expect(readlinkSync(join(directory, harness, 'skills/maximus')), harness).toBe(
      '../../node_modules/@arbol-ai/maximus/skills/maximus'
    );
  }
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
