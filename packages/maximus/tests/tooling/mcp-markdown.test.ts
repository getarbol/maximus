/**
 * The MCP server's description as Markdown in mcp/: instructions.md, guides/<name>.md with their # title and
 * skills/<name>.md with their frontmatter. A project configured in vite.config.ts serves them, even with no
 * tool; the other layouts configure `mcp` in code and refuse the files.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, expect, test } from 'vite-plus/test';

import { prepareProject } from '../../src/tooling/internal/prepare-project.ts';
import type { ProjectOptions } from '../../src/tooling/internal/prepare-project.ts';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** What vite.config.ts states for a tasks service. */
const options: ProjectOptions = {
  application: {
    name: 'tasks',
    namespace: 'tasks',
    title: 'Tasks',
    version: '1.0.0',
    origin: 'https://tasks.example.test',
    tokens: { issuer: 'https://issuer.example.test/', audience: 'https://tasks.example.test' },
    rpc: { callers: [] },
  },
  worker: { http: { basePath: '/api', healthPath: '/health' } },
  env: { production: {}, development: {} },
};

/** A project in a temporary directory, with these files. */
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'maximus-mcp-'));
  directories.push(root);
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), contents);
  }
  return root;
}

/** A generated module as text. */
function generated(root: string, name: string): string {
  return readFileSync(join(root, '.maximus', name), 'utf-8');
}

/** The MCP configuration the generated module holds. */
function described(root: string): unknown {
  return JSON.parse(
    /export const mcp: McpConfiguration = (.*);\n$/.exec(generated(root, 'mcp.ts'))?.[1] ?? ''
  );
}

const weeklyReview = [
  '---',
  'name: weekly-review',
  'description: "Review the open tasks every week: close, split or reschedule each one."',
  '---',
  '# Weekly review',
  '',
  'List the open tasks with list_tasks, then summarize them with summarize_tasks.',
  '',
].join('\n');

test('instructions, guides and skills describe the MCP server, which the Worker serves even with no tool', () => {
  const root = project({
    'mcp/instructions.md': 'Tasks belong to the caller organization.\n',
    'mcp/guides/task-conventions.md': '# Task conventions\n\nTitles start with a verb.\n',
    'mcp/skills/weekly-review.md': weeklyReview,
    'mcp/README.md': '# Notes for the team, not for clients',
  });
  prepareProject(root, 'production', options);
  expect(described(root)).toEqual({
    instructions: 'Tasks belong to the caller organization.\n',
    guides: [
      {
        name: 'task-conventions',
        title: 'Task conventions',
        text: '# Task conventions\n\nTitles start with a verb.\n',
      },
    ],
    skills: [
      {
        name: 'weekly-review',
        description: 'Review the open tasks every week: close, split or reschedule each one.',
        text: '# Weekly review\n\nList the open tasks with list_tasks, then summarize them with summarize_tasks.\n',
      },
    ],
  });
  const base = generated(root, 'base.ts');
  expect(base).toContain("import { mcp } from './mcp.ts';");
  expect(base).toContain('errors: standardErrors, mcp });');
  expect(generated(root, 'worker.ts')).toContain("import { mcp } from '@arbol-ai/maximus/mcp';");
});

test('each part stands alone, and the description goes when its Markdown does', () => {
  const root = project({ 'mcp/skills/weekly-review.md': weeklyReview });
  prepareProject(root, 'production', options);
  expect(described(root)).toMatchObject({ skills: [{ name: 'weekly-review' }] });
  expect(described(root)).not.toHaveProperty('instructions');
  expect(described(root)).not.toHaveProperty('guides');
  rmSync(join(root, 'mcp'), { recursive: true });
  expect(prepareProject(root, 'production', options).changed).toBe(true);
  expect(existsSync(join(root, '.maximus/mcp.ts'))).toBe(false);
  expect(generated(root, 'base.ts')).not.toContain('mcp');
  expect(generated(root, 'worker.ts')).not.toContain('@arbol-ai/maximus/mcp');
});

test('a guide starts with its # title', () => {
  for (const text of ['Task conventions\n', '\n# Task conventions\n', '## Task conventions\n', '# \n']) {
    const root = project({ 'mcp/guides/task-conventions.md': text });
    expect(() => prepareProject(root, 'production', options), text).toThrow(
      'Start the guide with its # title: mcp/guides/task-conventions.md'
    );
  }
});

test("a skill's frontmatter states its one-line description, and its name only as its file does", () => {
  const path = 'mcp/skills/weekly-review.md';
  const cases: [string, string][] = [
    ['# Weekly review\n', `Start the skill with frontmatter, ---, description: …, ---: ${path}`],
    [
      '---\nname: weekly-review\n---\n# Weekly review\n',
      `State the skill's one-line description in its frontmatter: ${path}`,
    ],
    ['---\ndescription:\n---\nText\n', `State the skill's one-line description in its frontmatter: ${path}`],
    [
      '---\nname: monthly-review\ndescription: Review.\n---\nText\n',
      `A skill's frontmatter states its one-line description, and its name only as its file does: ${path}`,
    ],
    [
      '---\ndescription: Review.\nallowed-tools: complete_task\n---\nText\n',
      `A skill's frontmatter states its one-line description, and its name only as its file does: ${path}`,
    ],
    [
      '---\ndescription: >\n  Review the tasks.\n---\nText\n',
      `A skill's frontmatter states its one-line description, and its name only as its file does: ${path}`,
    ],
  ];
  for (const [text, message] of cases) {
    const root = project({ [path]: text });
    expect(() => prepareProject(root, 'production', options), text).toThrow(message);
  }
});

test('guides and skills are kebab-case ordinary files, and other layouts set mcp in code', () => {
  for (const name of ['mcp/guides/Task_Conventions.md', `mcp/skills/${'a'.repeat(65)}.md`]) {
    const root = project({ [name]: '# Title\n' });
    expect(() => prepareProject(root, 'production', options), name).toThrow(
      `Name MCP Markdown in kebab-case, at most 64 characters: ${name}`
    );
  }
  const linked = project({ 'shared/conventions.md': '# Task conventions\n' });
  mkdirSync(join(linked, 'mcp/guides'), { recursive: true });
  symlinkSync(join(linked, 'shared/conventions.md'), join(linked, 'mcp/guides/task-conventions.md'));
  // As every file in a convention directory.
  expect(() => prepareProject(linked, 'production', options)).toThrow(
    'Project modules cannot be symlinks: mcp/guides/task-conventions.md'
  );
  const folder = project({ 'mcp/guides/task-conventions.md/notes.txt': '' });
  expect(() => prepareProject(folder, 'production', options)).toThrow(
    'MCP Markdown must be an ordinary file: mcp/guides/task-conventions.md'
  );
  const legacy = project({
    'src/application.ts': 'export const base = {};',
    'src/worker.ts': 'export const options = {};',
    'mcp/instructions.md': 'Tasks belong to the caller organization.\n',
  });
  expect(() => prepareProject(legacy)).toThrow(
    'mcp/*.md describes the MCP server of a project configured in vite.config.ts: set mcp in src/application.ts instead.'
  );
});
