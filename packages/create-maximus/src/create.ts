/**
 * What `create-maximus` asks and does: the project's directory, whether it serves MCP and whether it is a web
 * app, from the arguments or, in a terminal, from the person running it; then `maximus init` of the Maximus
 * release this package depends on.
 */
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';

/** What a new project is: where it goes, its name and what it serves. */
export interface ProjectChoice {
  directory: string;
  name: string;
  mcp: boolean;
  web: boolean;
}

/** Asks one question and answers what the person typed, or nothing for an empty answer. */
export type Ask = (question: string) => Promise<string>;

/** The help `--help` prints. */
export const USAGE = [
  'Usage: create-maximus [directory] [--name <name>] [--web] [--no-mcp] [--yes]',
  '',
  'Creates a Maximus project: an API on Cloudflare Workers whose greeting route is also an MCP tool,',
  'and with --web a React app. In a terminal it asks for what the arguments leave out; --yes takes the',
  'defaults: maximus-app, with MCP and without a web app.',
].join('\n');

/** A yes-or-no answer, or the default for an empty one. */
function yes(answer: string, fallback: boolean): boolean {
  const word = answer.trim().toLowerCase();
  if (!word) {
    return fallback;
  }
  if (['y', 'yes'].includes(word)) {
    return true;
  }
  if (['n', 'no'].includes(word)) {
    return false;
  }
  throw new TypeError(`Answer yes or no, not ${answer.trim()}.`);
}

/**
 * The project the arguments describe, completed by `ask` for what they leave out unless it is undefined
 * (no terminal) or `--yes` takes the defaults. Undefined for `--help`.
 */
export async function chooseProject(args: readonly string[], ask?: Ask): Promise<ProjectChoice | undefined> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    allowNegative: true,
    options: {
      name: { type: 'string' },
      web: { type: 'boolean' },
      mcp: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    return undefined;
  }
  if (positionals.length > 1) {
    throw new TypeError('Name one directory for the project.');
  }
  const interactive = ask && !values.yes ? ask : undefined;
  const typed = positionals[0] === undefined ? await interactive?.('Project directory (maximus-app): ') : '';
  const directory = positionals[0] ?? (typed?.trim() || 'maximus-app');
  const mcp =
    values.mcp ??
    (interactive ? yes(await interactive('Serve its routes to agents over MCP? (Y/n) '), true) : true);
  const web =
    values.web ?? (interactive ? yes(await interactive('Add a React web app? (y/N) '), false) : false);
  return { directory, name: values.name ?? basename(resolve(directory)), mcp, web };
}

/** The arguments of `maximus init` for a project. */
export function initArguments({ directory, name, mcp, web }: ProjectChoice): string[] {
  return ['init', directory, '--name', name, ...(web ? ['--web'] : []), ...(mcp ? [] : ['--no-mcp'])];
}
