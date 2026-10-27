#!/usr/bin/env node
/**
 * The `maximus` command creates projects and generates their `.maximus/` modules. Vite+ owns development
 * and builds; Cloudflare's `cf` owns deployment.
 */
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { scaffold } from './internal/scaffold.ts';

/** The help the command prints for `--help` or a usage mistake. */
const USAGE = [
  'Usage: maximus init <new-directory> [--name <name>]',
  '       maximus prepare [directory] [--mode production|development]',
  'init creates a Maximus project; prepare generates .maximus/ from vite.config.ts and the project files.',
].join('\n');

/** Runs the command the arguments name; an unknown or incomplete option is a refusal like any other. */
async function run(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      mode: { type: 'string', default: 'production' },
      help: { type: 'boolean', default: false },
    },
  });
  const [command, target] = positionals;
  if (values.help) {
    console.info(USAGE);
    return;
  }
  if (command === 'prepare') {
    const { prepareConfiguredProject } = await import('./internal/prepare-configured.ts');
    console.info(JSON.stringify(await prepareConfiguredProject(target ?? '.', values.mode)));
    return;
  }
  if (command !== 'init') {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (!target) {
    throw new TypeError('Use maximus init <new-directory> [--name <name>].');
  }
  console.info(JSON.stringify(scaffold(target, values.name ?? basename(resolve(target)))));
}

try {
  await run();
} catch (error) {
  // A refusal or a usage mistake is a sentence for the developer; MAXIMUS_DEBUG=1 shows the stack.
  console.error(error instanceof Error && !process.env.MAXIMUS_DEBUG ? `maximus: ${error.message}` : error);
  process.exitCode = 1;
}
