#!/usr/bin/env node
/**
 * `create-maximus`, as `bun create maximus my-api` or `npm create maximus@latest my-api` runs it: asks for
 * what the arguments leave out, creates the project with `maximus init` and says what to run next.
 */
import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { chooseProject, initArguments, USAGE } from './create.ts';

/** The `maximus` command of the release this package depends on. */
const MAXIMUS_CLI = fileURLToPath(new URL('tooling/cli.js', import.meta.resolve('@arbol-ai/maximus')));

try {
  // Questions only make sense in a terminal; anywhere else the arguments and the defaults decide.
  const terminal = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout })
    : undefined;
  let choice;
  try {
    choice = await chooseProject(
      process.argv.slice(2),
      terminal && ((question) => terminal.question(question))
    );
  } finally {
    terminal?.close();
  }
  if (choice) {
    execFileSync(process.execPath, [MAXIMUS_CLI, ...initArguments(choice)], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const into = relative(process.cwd(), choice.directory) || '.';
    console.info(
      [
        `Created ${choice.name}${choice.mcp ? ', an API and its MCP server' : ', an API'}${choice.web ? ' with a web app' : ''}.`,
        '',
        `  cd ${into}`,
        '  bun install',
        '  bun run dev',
        '',
        'Set origin and tokens.issuer in vite.config.ts before the first deployment.',
      ].join('\n')
    );
  } else {
    console.info(USAGE);
  }
} catch (error) {
  // `maximus init` reported its own refusal; any other failure is one sentence.
  if (!(error instanceof Error && 'status' in error)) {
    console.error(`create-maximus: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
}
