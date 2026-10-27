#!/usr/bin/env node
/**
 * The `maximus` command scaffolds services and reconciles project entries. Vite+ owns development and
 * builds; Cloudflare owns type generation and deployment.
 */
import { parseArgs } from 'node:util';

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
  'Creates a Vite+ service. Use its dev, build, verify and deploy package scripts.',
  'Project layout generates entries from vite.config.ts or maximus.config.ts, routes/, mcp/ and middleware/.',
].join('\n');
if (values.help) {
  console.info(USAGE);
  process.exit(0);
}

/** Runs the command the arguments name. */
async function run(): Promise<void> {
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
  if (!target || !values.name) {
    throw new TypeError('Use maximus init <new-directory> --name <name>.');
  }
  if (values.layout !== 'service' && values.layout !== 'project') {
    throw new TypeError('Choose --layout service or --layout project.');
  }
  console.info(JSON.stringify(scaffold(target, values.name, values.layout)));
}

try {
  await run();
} catch (error) {
  // A refusal or a usage mistake is a sentence for the developer; MAXIMUS_DEBUG=1 shows the stack.
  console.error(error instanceof Error && !process.env.MAXIMUS_DEBUG ? `maximus: ${error.message}` : error);
  process.exitCode = 1;
}
