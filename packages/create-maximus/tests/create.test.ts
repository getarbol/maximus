/**
 * `create-maximus`: the project the arguments describe, what it asks for in a terminal and how it reads the
 * answers, the `maximus init` it runs, and what it says to run next.
 */
import { expect, test, vi } from 'vite-plus/test';

import { chooseProject, create, initArguments, USAGE } from '../src/create.ts';

test('the arguments alone describe the project, with MCP and without a web app by default', async () => {
  expect(await chooseProject(['billing-api'])).toEqual({
    directory: 'billing-api',
    name: 'billing-api',
    mcp: true,
    web: false,
  });
  expect(await chooseProject(['apps/billing', '--name', 'billing-api', '--web', '--no-mcp'])).toEqual({
    directory: 'apps/billing',
    name: 'billing-api',
    mcp: false,
    web: true,
  });
  // Without a terminal, the defaults decide what the arguments leave out.
  expect(await chooseProject([])).toMatchObject({ directory: 'maximus-app', name: 'maximus-app' });
  expect(await chooseProject(['--help'])).toBeUndefined();
  await expect(chooseProject(['one', 'two'])).rejects.toThrow('Name one directory for the project.');
});

test('in a terminal it asks only for what the arguments leave out, unless --yes takes the defaults', async () => {
  const ask = vi.fn(async (question: string) => {
    if (question.startsWith('Project directory')) {
      return ' clinic-api ';
    }
    return question.startsWith('Serve') ? 'n' : 'YES';
  });
  expect(await chooseProject([], ask)).toEqual({
    directory: 'clinic-api',
    name: 'clinic-api',
    mcp: false,
    web: true,
  });
  expect(ask).toHaveBeenCalledTimes(3);
  ask.mockClear();
  expect(await chooseProject(['tasks', '--web'], ask)).toMatchObject({
    directory: 'tasks',
    web: true,
    mcp: false,
  });
  expect(ask.mock.calls.map(([question]) => question)).toEqual([
    'Serve its routes to agents over MCP? (Y/n) ',
  ]);
  ask.mockClear();
  expect(await chooseProject(['--yes'], ask)).toEqual({
    directory: 'maximus-app',
    name: 'maximus-app',
    mcp: true,
    web: false,
  });
  expect(ask).not.toHaveBeenCalled();
});

test('an empty answer takes the default, and an answer that is neither yes nor no is refused', async () => {
  expect(await chooseProject([], async () => '')).toEqual({
    directory: 'maximus-app',
    name: 'maximus-app',
    mcp: true,
    web: false,
  });
  await expect(chooseProject(['tasks'], async () => 'maybe')).rejects.toThrow('Answer yes or no, not maybe.');
});

test('the project becomes the arguments of maximus init', () => {
  expect(initArguments({ directory: 'tasks', name: 'tasks', mcp: true, web: false })).toEqual([
    'init',
    'tasks',
    '--name',
    'tasks',
  ]);
  expect(initArguments({ directory: 'apps/clinic', name: 'clinic', mcp: false, web: true })).toEqual([
    'init',
    'apps/clinic',
    '--name',
    'clinic',
    '--web',
    '--no-mcp',
  ]);
});

test('creates the project with maximus init and says what to run next, or shows the usage for --help', async () => {
  const io = { maximus: vi.fn(), print: vi.fn() };
  await create(['apps/clinic', '--web'], io, '/work');
  expect(io.maximus).toHaveBeenCalledExactlyOnceWith(['init', 'apps/clinic', '--name', 'clinic', '--web']);
  const [said] = io.print.mock.lastCall ?? [];
  expect(said).toContain('Created clinic, an API and its MCP server with a web app.');
  expect(said).toContain('  cd apps/clinic\n  bun install\n  bun run dev');
  // A project made where the command runs is entered as it is.
  await create(['/work', '--no-mcp'], io, '/work');
  expect(io.print.mock.lastCall?.[0]).toMatch(/^Created work, an API\.\n\n {2}cd \.\n/);
  io.maximus.mockClear();
  await create(['--help'], io, '/work');
  expect(io.print).toHaveBeenLastCalledWith(USAGE);
  expect(io.maximus).not.toHaveBeenCalled();
  // A refusal of maximus init is the command's, and nothing more is said.
  io.maximus.mockImplementation(() => {
    throw new Error('The directory is not empty.');
  });
  io.print.mockClear();
  await expect(create(['tasks'], io, '/work')).rejects.toThrow('The directory is not empty.');
  expect(io.print).not.toHaveBeenCalled();
});
