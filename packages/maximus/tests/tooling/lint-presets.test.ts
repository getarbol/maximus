/**
 * The oxlint and oxfmt presets as a consumer runs them: the guardrails they refuse, what Node code may do,
 * and the formatting they apply.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, expect, it } from 'vite-plus/test';

/**
 * The presets run the real oxlint and oxfmt, as a project that uses Maximus would: a new oxlint or
 * Ultracite that changes a guardrail, an override or what is ignored fails here, not in a service.
 */
const require = createRequire(import.meta.url);
const config = (name: string) => fileURLToPath(new URL(`../../config/${name}`, import.meta.url));
const binary = (name: 'oxfmt' | 'oxlint') =>
  join(dirname(require.resolve(`${name}/package.json`)), 'bin', name);
/**
 * The environment of a standalone oxlint or oxfmt run. Under `vp test`, VP_VERSION would make them read a
 * Vite+ configuration's `lint` field instead of the preset file a consumer passes with `-c`.
 */
const { VP_VERSION: _vitePlus, ...standalone } = process.env;

interface Diagnostic {
  code: string;
  filename: string;
  help?: string;
  message: string;
}

const WORKER_CODE = `import { z } from 'zod';
import { Hono } from 'hono';
import { maximus } from '@arbol-ai/maximus';
import { mcp } from '@arbol-ai/maximus/mcp';

export const call = () => fetch('https://example.test', { redirect: 'error' });
export const followed = () => fetch('https://example.test', { redirect: 'manual' });
export const secret = process.env.TOKEN;
export { Hono, maximus, mcp, z };
`;
const NODE_CODE = `export const call = () => fetch('https://example.test', { redirect: 'error' });
export const token = process.env.TOKEN;
`;

let root: string;
let diagnostics: Diagnostic[];
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'maximus-lint-'));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write('oxlint.config.mjs', `export { default } from ${JSON.stringify(config('oxlint.mjs'))};\n`);
  write('src/worker.ts', WORKER_CODE);
  write('scripts/release.ts', NODE_CODE);
  write('tests/worker.test.ts', NODE_CODE);
  write('vite.config.ts', NODE_CODE);
  write('dist/worker.ts', WORKER_CODE);
  write('.cloudflare/output/v0/workers/default/bundle/index.ts', WORKER_CODE);
  write('.cloudflare/types/index.d.ts', `/* eslint-disable */\n${WORKER_CODE}`);
  for (const route of [
    '[taskId].get.ts',
    '[noteId].ts',
    '[listId].delete.dev.ts',
    'taskLists.get.ts',
    '[taskId]Extra.get.ts',
  ]) {
    write(`routes/v1/tasks/${route}`, 'export default {};\n');
  }
  let output: string;
  try {
    output = execFileSync(
      process.execPath,
      [binary('oxlint'), '-c', 'oxlint.config.mjs', '--format', 'json', '.'],
      {
        cwd: root,
        encoding: 'utf-8',
        env: standalone,
      }
    );
  } catch (error) {
    // oxlint exits 1 when it reports errors; the report is still on stdout.
    output = (error as { stdout: string }).stdout;
  }
  ({ diagnostics } = JSON.parse(output) as { diagnostics: Diagnostic[] });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const reported = (filename: string, code: string) =>
  diagnostics.filter((diagnostic) => diagnostic.filename === filename && diagnostic.code === code);

it("refuses fetch's redirect: 'error' in Worker code and says what to do instead", () => {
  const [redirect, ...others] = reported('src/worker.ts', 'maximus(no-fetch-redirect-error)');
  expect(others).toHaveLength(0);
  expect(redirect?.message).toContain("redirect: 'manual'");
});

it('keeps configuration out of process.env in Worker code', () => {
  const [usage] = reported('src/worker.ts', 'eslint(no-restricted-properties)');
  expect(usage?.help).toContain('Secrets Store');
});

it('refuses other schema libraries and other routers', () => {
  const refused = reported('src/worker.ts', 'eslint(no-restricted-imports)');
  // Each diagnostic names its specifier first; the guidance is its help.
  const about = (specifier: string) =>
    refused
      .filter((diagnostic) => diagnostic.message.startsWith(`'${specifier}' import`))
      .map((diagnostic) => diagnostic.help ?? '');
  expect(about('zod').join(',')).toContain('TypeBox');
  expect(about('hono').join(',')).toContain('one definition');
  for (const allowed of ['@arbol-ai/maximus', '@arbol-ai/maximus/mcp']) {
    expect(about(allowed)).toHaveLength(0);
  }
});

it('lets code that runs in Node use its fetch options and its environment', () => {
  for (const file of ['scripts/release.ts', 'tests/worker.test.ts', 'vite.config.ts']) {
    expect(reported(file, 'maximus(no-fetch-redirect-error)')).toHaveLength(0);
    expect(reported(file, 'eslint(no-restricted-properties)')).toHaveLength(0);
  }
});

it('lets a route file name its path parameter as its input field, and nothing else break kebab-case', () => {
  const named = (route: string) => reported(`routes/v1/tasks/${route}`, 'unicorn(filename-case)');
  for (const route of ['[taskId].get.ts', '[noteId].ts', '[listId].delete.dev.ts']) {
    expect(named(route), route).toHaveLength(0);
  }
  for (const route of ['taskLists.get.ts', '[taskId]Extra.get.ts']) {
    expect(named(route), route).toHaveLength(1);
  }
});

it('leaves build output alone', () => {
  expect(diagnostics.filter((diagnostic) => /^(?:dist|\.cloudflare)\//.test(diagnostic.filename))).toEqual(
    []
  );
});

it('formats with single quotes in 110 columns', () => {
  const directory = join(root, 'format');
  mkdirSync(directory);
  writeFileSync(
    join(directory, 'oxfmt.config.mjs'),
    `export { default } from ${JSON.stringify(config('oxfmt.mjs'))};\n`
  );
  writeFileSync(join(directory, 'quoted.ts'), 'export const greeting = "hello";\n');
  writeFileSync(join(directory, 'formatted.ts'), "export const greeting = 'hello';\n");
  const check = (file: string) => {
    try {
      execFileSync(process.execPath, [binary('oxfmt'), '-c', 'oxfmt.config.mjs', '--check', file], {
        cwd: directory,
        env: standalone,
        stdio: 'pipe',
      });
      return true;
    } catch {
      return false;
    }
  };
  expect(check('formatted.ts')).toBe(true);
  expect(check('quoted.ts')).toBe(false);
});
