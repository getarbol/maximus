#!/usr/bin/env node
/**
 * `create-maximus`, as `bun create maximus my-api` runs it: `create` with
 * the person's terminal, if there is one, and the `maximus` command of the release this package depends on.
 */
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { create } from './create.ts';

/** The `maximus` command of the release this package depends on. */
const MAXIMUS_CLI = fileURLToPath(new URL('tooling/cli.js', import.meta.resolve('@arbol-ai/maximus')));

// Questions only make sense in a terminal; anywhere else the arguments and the defaults decide.
const terminal = process.stdin.isTTY
  ? createInterface({ input: process.stdin, output: process.stdout })
  : undefined;
try {
  await create(process.argv.slice(2), {
    ask: terminal && ((question) => terminal.question(question)),
    maximus: (args) => {
      execFileSync(process.execPath, [MAXIMUS_CLI, ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
    },
    print: (text) => console.info(text),
  });
} catch (error) {
  // `maximus init` reported its own refusal; any other failure is one sentence.
  if (!(error instanceof Error && 'status' in error)) {
    console.error(`create-maximus: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
} finally {
  terminal?.close();
}
