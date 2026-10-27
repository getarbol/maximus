/**
 * The MCP server's description as Markdown in mcp/: instructions.md, guides/<name>.md with their # title and
 * skills/<name>.md with their frontmatter, which the Worker serves even with no tool.
 */
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vite-plus/test';

import { generated, prepare, project, removeProjects } from './fixtures.ts';

afterEach(removeProjects);

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
  prepare(root);
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
  prepare(root);
  expect(described(root)).toMatchObject({ skills: [{ name: 'weekly-review' }] });
  expect(described(root)).not.toHaveProperty('instructions');
  expect(described(root)).not.toHaveProperty('guides');
  rmSync(join(root, 'mcp'), { recursive: true });
  expect(prepare(root).changed).toBe(true);
  expect(existsSync(join(root, '.maximus/mcp.ts'))).toBe(false);
  expect(generated(root, 'base.ts')).not.toContain('mcp');
  expect(generated(root, 'worker.ts')).not.toContain('@arbol-ai/maximus/mcp');
});

test('a guide starts with its # title', () => {
  for (const text of ['Task conventions\n', '\n# Task conventions\n', '## Task conventions\n', '# \n']) {
    const root = project({ 'mcp/guides/task-conventions.md': text });
    expect(() => prepare(root), text).toThrow(
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
    expect(() => prepare(root), text).toThrow(message);
  }
});

test("a guide and a skill never share a resource name, nor take the OpenAPI document's", () => {
  for (const [files, name] of [
    [
      { 'mcp/guides/weekly-review.md': '# Weekly review\n', 'mcp/skills/weekly-review.md': weeklyReview },
      'weekly-review',
    ],
    [{ 'mcp/guides/openapi-json.md': '# The document\n' }, 'openapi-json'],
    [{ 'mcp/skills/openapi-yaml.md': weeklyReview.replace('weekly-review', 'openapi-yaml') }, 'openapi-yaml'],
  ] as const) {
    expect(() => prepare(project(files)), name).toThrow(
      `MCP resource name ${name} is taken: guides and skills need names of their own, and openapi-json and openapi-yaml name the OpenAPI document.`
    );
  }
});

test('guides and skills are kebab-case ordinary files', () => {
  for (const name of ['mcp/guides/Task_Conventions.md', `mcp/skills/${'a'.repeat(65)}.md`]) {
    const root = project({ [name]: '# Title\n' });
    expect(() => prepare(root), name).toThrow(
      `Name MCP Markdown in kebab-case, at most 64 characters: ${name}`
    );
  }
  const linked = project({ 'shared/conventions.md': '# Task conventions\n' });
  mkdirSync(join(linked, 'mcp/guides'), { recursive: true });
  symlinkSync(join(linked, 'shared/conventions.md'), join(linked, 'mcp/guides/task-conventions.md'));
  // As every file in a convention directory.
  expect(() => prepare(linked)).toThrow('Project modules cannot be symlinks: mcp/guides/task-conventions.md');
  const folder = project({ 'mcp/guides/task-conventions.md/notes.txt': '' });
  expect(() => prepare(folder)).toThrow(
    'MCP Markdown must be an ordinary file: mcp/guides/task-conventions.md'
  );
  const instructions = project({ 'mcp/instructions.md/notes.txt': '' });
  expect(() => prepare(instructions)).toThrow('MCP Markdown must be an ordinary file: mcp/instructions.md');
  // A whole directory linked from elsewhere is refused as its files are.
  const directory = project({ 'shared/guides/task-conventions.md': '# Task conventions\n' });
  mkdirSync(join(directory, 'mcp'));
  symlinkSync(join(directory, 'shared/guides'), join(directory, 'mcp/guides'));
  expect(() => prepare(directory)).toThrow('Project modules cannot be symlinks: mcp/guides');
});

test('guides and skills are described in the order of their names, whatever order the files are read in', () => {
  const root = project({
    'mcp/guides/triage.md': '# Triage\n',
    'mcp/guides/discharge.md': '# Discharge\n',
    'mcp/guides/admission.md': '# Admission\n',
  });
  prepare(root);
  expect(described(root)).toMatchObject({
    guides: [{ name: 'admission' }, { name: 'discharge' }, { name: 'triage' }],
  });
});
