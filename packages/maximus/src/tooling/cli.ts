#!/usr/bin/env node
/**
 * The `maximus` command: creates projects, generates their routes and tools, links the Maximus skill for
 * coding agents and writes `.maximus/`. Vite+ owns development and builds; Cloudflare's `cf` deploys.
 */
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';

/** The help the command prints for `--help` or a usage mistake. */
const USAGE = [
  'Usage: maximus init <new-directory> [--name <name>] [--web] [--no-mcp]',
  '       maximus gen route <method> <path> [--tool <mcp_tool_name>] [--root <directory>]',
  '       maximus gen tool <name> [--root <directory>]',
  '       maximus skills [directory]',
  '       maximus prepare [directory] [--mode production|development]',
  '',
  'init      creates a project: an API whose greeting route is also an MCP tool, and with --web a React app.',
  'gen       writes a route file (routes/v1/tasks/[taskId].get.ts) or an MCP tool file (mcp/tools/<name>.ts).',
  "skills    links the installed Maximus skill into the project's .agents, .claude and .codex skill folders.",
  'prepare   writes .maximus/ from vite.config.ts and the project files, as vp dev and vp build do.',
].join('\n');

/** Runs the command the arguments name; an unknown or incomplete option is a refusal like any other. */
async function run(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    allowNegative: true,
    options: {
      name: { type: 'string' },
      web: { type: 'boolean', default: false },
      mcp: { type: 'boolean', default: true },
      tool: { type: 'string' },
      root: { type: 'string', default: '.' },
      mode: { type: 'string', default: 'production' },
      help: { type: 'boolean', default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help) {
    console.info(USAGE);
    return;
  }
  switch (command) {
    case 'init': {
      const [target] = rest;
      if (!target) {
        throw new TypeError('Use maximus init <new-directory> [--name <name>].');
      }
      const { scaffold } = await import('./internal/scaffold.ts');
      const name = values.name ?? basename(resolve(target));
      console.info(JSON.stringify(scaffold(target, name, { mcp: values.mcp, web: values.web })));
      return;
    }
    case 'gen': {
      const { generateRoute, generateTool } = await import('./internal/generate.ts');
      const [kind, ...args] = rest;
      if (kind === 'route' && args.length === 2) {
        const [method = '', path = ''] = args;
        console.info(JSON.stringify(generateRoute(values.root, method, path, values.tool)));
        return;
      }
      if (kind === 'tool' && args.length === 1) {
        console.info(JSON.stringify(generateTool(values.root, args[0] ?? '')));
        return;
      }
      throw new TypeError('Use maximus gen route <method> <path>, or maximus gen tool <name>.');
    }
    case 'skills': {
      const { linkAgentSkills } = await import('./internal/agent-skills.ts');
      console.info(JSON.stringify({ linked: linkAgentSkills(rest[0] ?? '.') }));
      return;
    }
    case 'prepare': {
      if (values.mode !== 'production' && values.mode !== 'development') {
        throw new TypeError(
          'Prepare with --mode production, as a build does, or development, as vp dev does.'
        );
      }
      const { prepareConfiguredProject } = await import('./internal/prepare-configured.ts');
      console.info(JSON.stringify(await prepareConfiguredProject(rest[0] ?? '.', values.mode)));
      return;
    }
    default: {
      console.error(USAGE);
      process.exitCode = 1;
    }
  }
}

try {
  await run();
} catch (error) {
  // A refusal or a usage mistake is a sentence for the developer; MAXIMUS_DEBUG=1 shows the stack.
  console.error(error instanceof Error && !process.env.MAXIMUS_DEBUG ? `maximus: ${error.message}` : error);
  process.exitCode = 1;
}
