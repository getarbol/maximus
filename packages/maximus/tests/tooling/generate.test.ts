/**
 * `maximus gen` and `maximus skills`: a route or tool file named and placed by the conventions prepare reads,
 * written as the house style asks (a comment that names it, a handler of statements, a description that says
 * what to write) and laid out as the formatter writes it, never over an existing file or a route another file
 * answers; and the Maximus skill linked for each coding agent without replacing what is there. Neither writes
 * through a folder linked from elsewhere.
 */
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, expect, test } from 'vite-plus/test';

import { linkAgentSkills } from '../../src/tooling/internal/agent-skills.ts';
import { generateRoute, generateTool } from '../../src/tooling/internal/generate.ts';
import { generated, prepare, project, removeProjects, ROUTE, temporary } from './fixtures.ts';

afterEach(removeProjects);

/** Where the workspace installed a formatter or linter binary. */
const require = createRequire(import.meta.url);

/**
 * Whether oxfmt, with the Maximus preset a project uses, would leave each file as it is. Under `vp test`,
 * VP_VERSION would make oxfmt read a Vite+ configuration instead of the preset passed with `-c`.
 */
function isFormatted(root: string, files: readonly string[]): boolean {
  const preset = fileURLToPath(new URL('../../config/oxfmt.mjs', import.meta.url));
  writeFileSync(join(root, 'oxfmt.config.mjs'), `export { default } from ${JSON.stringify(preset)};\n`);
  const oxfmt = join(dirname(require.resolve('oxfmt/package.json')), 'bin', 'oxfmt');
  const { VP_VERSION: _vitePlus, ...environment } = process.env;
  try {
    execFileSync(process.execPath, [oxfmt, '-c', 'oxfmt.config.mjs', '--check', ...files], {
      cwd: root,
      env: environment,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

test('a route names itself in a comment, answers its path parameters back in statements and, when asked, is an MCP tool', () => {
  const root = project({});
  expect(generateRoute(root, 'GET', '/v1/tasks/{taskId}', 'get_task')).toEqual({
    file: join(root, 'routes/v1/tasks/[taskId].get.ts'),
    method: 'GET',
    path: '/v1/tasks/{taskId}',
  });
  expect(readFileSync(join(root, 'routes/v1/tasks/[taskId].get.ts'), 'utf-8')).toBe(
    [
      "import { defineHandler, t } from '@arbol-ai/maximus';",
      '',
      '/** GET /api/v1/tasks/{taskId}, also the MCP tool get_task: what it answers, in a few words. */',
      'export default defineHandler(',
      '  ({ input }) => {',
      '    const { taskId } = input;',
      '    return { taskId };',
      '  },',
      '  {',
      "    description: 'Write one sentence that tells callers what GET /api/v1/tasks/{taskId} does.',",
      '    input: { taskId: t.String() },',
      '    output: { taskId: t.String() },',
      "    mcp: { name: 'get_task' },",
      '  }',
      ');',
      '',
    ].join('\n')
  );
  // prepare reads what gen writes: the route is bound at its path, and its tool brings the MCP transport.
  prepare(root);
  expect(generated(root, 'app.ts')).toContain('"/v1/tasks/{taskId}", "GET"');
  expect(generated(root, 'worker.ts')).toContain('mcp()');
});

test('a path is written however it is spelled, and a folder that exists takes the route as its index', () => {
  const root = project({ 'routes/v1/tasks/[taskId].get.ts': ROUTE });
  expect(generateRoute(root, 'post', '/api/v1/tasks').file).toBe(join(root, 'routes/v1/tasks/index.post.ts'));
  expect(generateRoute(root, 'delete', 'v1/tasks/:taskId').file).toBe(
    join(root, 'routes/v1/tasks/[taskId].delete.ts')
  );
  expect(generateRoute(root, 'patch', '/v1/tasks/[taskId]/labels').file).toBe(
    join(root, 'routes/v1/tasks/[taskId]/labels.patch.ts')
  );
  expect(generateRoute(root, 'put', '/v2/settings').file).toBe(join(root, 'routes/v2/settings.put.ts'));
  // Without a path parameter, the route takes and answers nothing until it declares more.
  expect(readFileSync(join(root, 'routes/v1/tasks/index.post.ts'), 'utf-8')).toBe(
    [
      "import { defineHandler } from '@arbol-ai/maximus';",
      '',
      '/** POST /api/v1/tasks: what it answers, in a few words. */',
      'export default defineHandler(() => {}, {',
      "  description: 'Write one sentence that tells callers what POST /api/v1/tasks does.',",
      '});',
      '',
    ].join('\n')
  );
  // A comment too long for one line wraps, and so does a description, on a line of its own.
  const long = generateRoute(
    root,
    'get',
    '/v1/organizations/{organizationSlug}/projects/{projectSlug}/tasks/{taskId}'
  );
  expect(readFileSync(long.file, 'utf-8')).toContain(
    [
      '/**',
      ' * GET /api/v1/organizations/{organizationSlug}/projects/{projectSlug}/tasks/{taskId}: what it answers, in a',
      ' * few words.',
      ' */',
    ].join('\n')
  );
  expect(readFileSync(long.file, 'utf-8')).toContain(
    "    description:\n      'Write one sentence that tells callers what GET /api/v1/organizations/"
  );
  prepare(root);
});

test('what gen writes is what the formatter writes, however long its path, its parameters or its tool name', () => {
  const root = project({});
  const files = [
    generateRoute(root, 'get', '/v1/tasks/{taskId}', 'get_task').file,
    generateRoute(root, 'post', '/v1/tasks').file,
    generateRoute(root, 'get', '/v1/organizations/{organizationSlug}/projects/{projectSlug}/tasks/{taskId}')
      .file,
    // Fields too long for one line, and a pattern that breaks after `=` before its braces do.
    generateRoute(
      root,
      'patch',
      '/v1/organizations/{organizationIdentifier}/projects/{projectIdentifierNumber}/tasks/{taskIdentifierNumber}'
    ).file,
    // A pattern too long even alone, which breaks one name per line.
    generateRoute(
      root,
      'put',
      '/v1/a/{organizationSlugNumberOne}/b/{projectSlugNumberTwo}/c/{taskIdentifierNumberThree}/d/{anotherLongName}'
    ).file,
    generateRoute(
      root,
      'get',
      '/v1/a-very-long-collection-name-for-the-layout/another-long-segment-name/and-one-more',
      'list_a_very_long_tool_name_that_goes_on_and_on_and_on'
    ).file,
    generateTool(root, 'summarize-tasks').file,
    generateTool(root, 'summarize-every-task-of-the-organization-for-the-weekly-review').file,
  ];
  expect(isFormatted(root, files)).toBe(true);
  // The check refuses a file the formatter would change.
  writeFileSync(join(root, 'unformatted.ts'), 'export const greeting = "hello"\n');
  expect(isFormatted(root, [join(root, 'unformatted.ts')])).toBe(false);
});

test('a route a file already answers, an unknown method, a path outside a version, an unsafe parameter and a bad tool name are refused', () => {
  const root = project({ 'routes/v1/tasks/[taskId].get.ts': ROUTE });
  expect(() => generateRoute(root, 'get', '/v1/tasks/{id}')).toThrow(
    'routes/v1/tasks/[taskId].get.ts already answers GET /v1/tasks/{id}.'
  );
  expect(() => generateRoute(root, 'head', '/v1/tasks')).toThrow(
    'Choose a route method: get, post, put, patch, delete.'
  );
  for (const path of ['/tasks', '/v1', '/v0/tasks', '/api/tasks']) {
    expect(() => generateRoute(root, 'get', path), path).toThrow(
      'A route lives below its API version, such as /v1/tasks'
    );
  }
  expect(() => generateRoute(root, 'get', '/v1/tasks/{task-id}')).toThrow(
    'Use letters, digits, _ and - in a fixed segment'
  );
  // A name the Worker would refuse as it starts, since it would reach an object's prototype.
  expect(() => generateRoute(root, 'get', '/v1/tasks/{constructor}')).toThrow(
    new TypeError('Path parameter names must be unique and safe: /v1/tasks/{constructor}')
  );
  expect(() => generateRoute(root, 'get', '/v1/tasks', 'list-tasks')).toThrow(
    'Name an MCP tool in snake_case'
  );
});

test('a tool file is named in kebab-case and its tool in snake_case, and an existing file is never overwritten', () => {
  const root = project({});
  expect(generateTool(root, 'summarize-tasks')).toEqual({
    file: join(root, 'mcp/tools/summarize-tasks.ts'),
    tool: 'summarize_tasks',
  });
  expect(readFileSync(join(root, 'mcp/tools/summarize-tasks.ts'), 'utf-8')).toBe(
    [
      "import { defineTool, t } from '@arbol-ai/maximus';",
      '',
      '/** The MCP tool summarize_tasks, which no HTTP route serves: what it answers, in a few words. */',
      'export default defineTool(',
      '  ({ input }) => {',
      '    const { text } = input;',
      '    return { text };',
      '  },',
      '  {',
      "    description: 'Write one sentence that tells agents what summarize_tasks does.',",
      "    effect: 'read',",
      '    input: { text: t.String({ maxLength: 1000 }) },',
      '    output: { text: t.String() },',
      '  }',
      ');',
      '',
    ].join('\n')
  );
  prepare(root);
  expect(generated(root, 'app.ts')).toContain('bindTool(base, tool_0, "summarize-tasks")');
  expect(() => generateTool(root, 'summarize-tasks')).toThrow(
    'mcp/tools/summarize-tasks.ts exists; edit it instead.'
  );
  expect(() => generateTool(root, 'Summarize')).toThrow('Name a tool file in kebab-case');
  expect(() => generateTool(root, '../escape')).toThrow('Name a tool file in kebab-case');
});

/** A new project whose `folder` is a symlink to a new empty directory elsewhere, and that directory. */
function linkedProject(folder: string): { root: string; elsewhere: string } {
  const root = project({});
  const elsewhere = temporary();
  mkdirSync(join(root, dirname(folder)), { recursive: true });
  symlinkSync(elsewhere, join(root, folder));
  return { root, elsewhere };
}

test('a tool is never written through mcp/ or mcp/tools/ linked from elsewhere', () => {
  for (const folder of ['mcp', 'mcp/tools']) {
    const { root, elsewhere } = linkedProject(folder);
    expect(() => generateTool(root, 'summarize-tasks'), folder).toThrow(
      `Project directory cannot be a symlink: ${folder}`
    );
    expect(readdirSync(elsewhere), folder).toEqual([]);
  }
});

test('the Maximus skill is linked for each agent once, and anything else at a link path is refused', () => {
  const root = project({});
  expect(linkAgentSkills(root)).toEqual([
    '.agents/skills/maximus',
    '.claude/skills/maximus',
    '.codex/skills/maximus',
  ]);
  expect(readlinkSync(join(root, '.claude/skills/maximus'))).toBe(
    '../../node_modules/@arbol-ai/maximus/skills/maximus'
  );
  // Linking again keeps the links in place.
  expect(linkAgentSkills(root)).toEqual([]);
  const own = project({ '.claude/skills/maximus/SKILL.md': '# Our own notes' });
  expect(() => linkAgentSkills(own)).toThrow(
    '.claude/skills/maximus exists and is not the Maximus skill link; move it first.'
  );
  // Nothing was linked before the refusal.
  expect(lstatSync(join(own, '.agents/skills/maximus'), { throwIfNoEntry: false })).toBeUndefined();
  const elsewhere = project({});
  mkdirSync(join(elsewhere, '.codex/skills'), { recursive: true });
  symlinkSync('/somewhere/else', join(elsewhere, '.codex/skills/maximus'));
  expect(() => linkAgentSkills(elsewhere)).toThrow('.codex/skills/maximus exists');
});

test('the skill is never linked through an agent folder or its skills folder linked from elsewhere', () => {
  for (const folder of ['.claude', '.codex/skills']) {
    const { root, elsewhere } = linkedProject(folder);
    expect(() => linkAgentSkills(root), folder).toThrow(`Project directory cannot be a symlink: ${folder}`);
    expect(readdirSync(elsewhere), folder).toEqual([]);
    // Nothing was linked before the refusal.
    expect(
      lstatSync(join(root, '.agents/skills/maximus'), { throwIfNoEntry: false }),
      folder
    ).toBeUndefined();
  }
});
