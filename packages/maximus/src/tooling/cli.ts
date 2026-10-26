#!/usr/bin/env node
/**
 * The `maximus` command: `init` creates a new service. Developing, building and deploying it are `cf`'s own
 * commands, which Maximus does not wrap.
 */
import { parseArgs } from 'node:util';

import { prepareProject } from './internal/prepare-project.ts';
import { scaffold } from './internal/scaffold.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    layout: { type: 'string', default: 'service' },
    mode: { type: 'string', default: 'production' },
    help: { type: 'boolean', default: false },
  },
});
const [command, target] = positionals;
/** The help the command prints for `--help` or a usage mistake. */
const USAGE = [
  'Usage: maximus init <new-directory> --name <name> [--layout service|project]',
  '       maximus prepare [directory] [--mode production|development]',
  'Creates a new service. Develop, build and deploy it with cf: cf dev, cf build, cf workers types and',
  'cf deploy.',
].join('\n');
if (values.help) {
  console.info(USAGE);
  process.exit(0);
}

/** Runs the command the arguments name. */
function run(): void {
  if (command === 'prepare') {
    console.info(JSON.stringify(prepareProject(target ?? '.', values.mode)));
    return;
  }
  if (command !== 'init') {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (!target || !values.name) {
    throw new TypeError('Use maximus init <new-directory> --name <name>.');
  }
  if (values.layout !== 'service' && values.layout !== 'project') {
    throw new TypeError('Choose --layout service or --layout project.');
  }
  console.info(JSON.stringify(scaffold(target, values.name, values.layout)));
}

try {
  run();
} catch (error) {
  // A refusal or a usage mistake is a sentence for the developer; MAXIMUS_DEBUG=1 shows the stack.
  console.error(error instanceof Error && !process.env.MAXIMUS_DEBUG ? `maximus: ${error.message}` : error);
  process.exitCode = 1;
}
