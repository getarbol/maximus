/**
 * The `maximus` command, run in this process with its arguments: help and usage, `init` with its name and
 * refusals, `prepare` for a directory and mode, and failures reported as one sentence unless MAXIMUS_DEBUG
 * asks for the error itself.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, expect, test, vi } from 'vite-plus/test';

import { options, project, removeProjects, temporary } from './fixtures.ts';

/** A `process.exit` call, thrown so the command stops where the process would have ended. */
class ExitError extends Error {
  readonly code: string | number | null | undefined;
  constructor(code: string | number | null | undefined) {
    super(`process.exit(${code})`);
    this.name = 'ExitError';
    this.code = code;
  }
}

const ARGV = process.argv;
const CWD = process.cwd();
/** Inside the workspace's node_modules, where a bundled configuration resolves Vite and its imports. */
const CACHE = fileURLToPath(new URL('../../../../node_modules/.cache/', import.meta.url));

afterEach(() => {
  process.argv = ARGV;
  process.exitCode = undefined;
  process.chdir(CWD);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  removeProjects();
});

/** Runs `maximus ...args` as the binary would: what it printed and reported, and how it ended. */
async function maximus(...args: string[]) {
  process.argv = [ARGV[0] ?? 'node', 'maximus', ...args];
  process.exitCode = undefined;
  vi.restoreAllMocks();
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new ExitError(code);
  });
  vi.resetModules();
  let exited: ExitError | undefined;
  try {
    await import('../../src/tooling/cli.ts');
  } catch (error_) {
    if (!(error_ instanceof ExitError)) {
      throw error_;
    }
    exited = error_;
  }
  return {
    printed: info.mock.calls.map(([line]) => line as unknown),
    reported: error.mock.calls.map(([line]) => line as unknown),
    exitCode: exited ? exited.code : process.exitCode,
  };
}

test('--help prints the usage of init and prepare and exits successfully', async () => {
  const { printed, reported, exitCode } = await maximus('--help');
  expect(exitCode).toBeUndefined();
  expect(reported).toEqual([]);
  expect(printed).toHaveLength(1);
  expect(printed[0]).toContain('Usage: maximus init <new-directory> [--name <name>]');
  expect(printed[0]).toContain('maximus prepare [directory] [--mode production|development]');
});

test('a missing or unknown command reports the usage and fails', async () => {
  for (const args of [[], ['deploy']]) {
    const { printed, reported, exitCode } = await maximus(...args);
    expect(exitCode, args.join(' ')).toBe(1);
    expect(printed).toEqual([]);
    expect(String(reported[0])).toContain('Usage: maximus init <new-directory>');
  }
});

test('init scaffolds a project named after its directory unless --name names it, and prints what to do next', async () => {
  const directory = join(temporary(), 'tasks');
  const { printed, reported, exitCode } = await maximus('init', directory);
  expect(exitCode).toBeUndefined();
  expect(reported).toEqual([]);
  expect(JSON.parse(String(printed[0]))).toMatchObject({
    directory,
    next: expect.stringContaining('bun run deploy'),
  });
  expect(existsSync(join(directory, 'routes/v1/greeting.get.ts'))).toBe(true);
  expect(readFileSync(join(directory, 'package.json'), 'utf-8')).toContain('"name": "tasks"');
  const named = join(temporary(), 'service');
  await maximus('init', named, '--name', 'billing-api');
  expect(readFileSync(join(named, 'package.json'), 'utf-8')).toContain('"name": "billing-api"');
});

test('init without a directory is refused as one sentence', async () => {
  const { printed, reported, exitCode } = await maximus('init', '--name', 'tasks');
  expect(reported).toEqual(['maximus: Use maximus init <new-directory> [--name <name>].']);
  expect(exitCode).toBe(1);
  expect(printed).toEqual([]);
});

test('an unknown option or an option without its value is refused as one sentence', async () => {
  const directory = join(temporary(), 'tasks');
  for (const [args, sentence] of [
    [['init', directory, '--nme', 'tasks'], /^maximus: Unknown option '--nme'/],
    [['init', directory, '--name'], /^maximus: Option '--name <value>' argument missing/],
  ] as const) {
    const { printed, reported, exitCode } = await maximus(...args);
    expect(reported, args.join(' ')).toHaveLength(1);
    expect(String(reported[0]), args.join(' ')).toMatch(sentence);
    expect(exitCode).toBe(1);
    expect(printed).toEqual([]);
  }
  expect(existsSync(directory)).toBe(false);
});

test('a refusal is one sentence, and MAXIMUS_DEBUG=1 reports the error itself', async () => {
  const existing = temporary();
  const refused = await maximus('init', existing, '--name', 'tasks');
  expect(refused.reported).toEqual([
    'maximus: Choose a new directory; existing projects are never overwritten.',
  ]);
  expect(refused.exitCode).toBe(1);
  vi.stubEnv('MAXIMUS_DEBUG', '1');
  const debugged = await maximus('init', existing, '--name', 'Tasks');
  expect(debugged.reported).toHaveLength(1);
  expect(debugged.reported[0]).toBeInstanceOf(TypeError);
  expect((debugged.reported[0] as Error).message).toBe(
    'Use a lowercase kebab-case project name of 2 to 41 characters.'
  );
  expect(debugged.exitCode).toBe(1);
});

/** A project whose vite.config.ts configures the plugin from source, with one route. */
function configured(): string {
  const plugin = fileURLToPath(new URL('../../src/tooling/vite.ts', import.meta.url));
  return project(
    {
      'vite.config.ts': `import { maximusProject } from ${JSON.stringify(plugin)};\nexport default { plugins: [maximusProject(() => (${JSON.stringify(options())}))] };\n`,
      'routes/v1/notes.get.ts': 'export default defineHandler(() => ({}));',
    },
    CACHE
  );
}

test('prepare generates the project at the given directory for the given mode', async () => {
  const root = configured();
  const { printed, reported, exitCode } = await maximus('prepare', root, '--mode', 'development');
  expect(exitCode).toBeUndefined();
  expect(reported).toEqual([]);
  expect(JSON.parse(String(printed[0]))).toMatchObject({
    directory: root,
    mode: 'development',
    modules: { routes: 1 },
  });
  expect(readFileSync(join(root, '.maximus/app.ts'), 'utf-8')).toContain(
    '// Generated by maximus prepare (development).'
  );
});

test('prepare defaults to the working directory and the production mode', async () => {
  const root = configured();
  process.chdir(root);
  const { printed } = await maximus('prepare');
  expect(JSON.parse(String(printed[0]))).toMatchObject({ directory: process.cwd(), mode: 'production' });
  expect(readFileSync(join(root, '.maximus/app.ts'), 'utf-8')).toContain(
    '// Generated by maximus prepare (production).'
  );
});

test('a project prepare cannot configure is refused as one sentence', async () => {
  const root = project({ 'routes/v1/notes.get.ts': 'export default defineHandler(() => ({}));' });
  const { reported, exitCode } = await maximus('prepare', root);
  expect(exitCode).toBe(1);
  expect(reported).toEqual([
    'maximus: Configure the project in vite.config.ts with maximus() from @arbol-ai/vite-plugin.',
  ]);
  expect(existsSync(join(root, '.maximus'))).toBe(false);
});
