#!/usr/bin/env node
/**
 * The `maximus` command: creates projects, generates their routes and tools, links the Maximus skill for
 * coding agents and writes `.maximus/`. Vite+ owns development and builds; Cloudflare's `cf` deploys.
 */
import { basename, relative, resolve } from 'node:path';
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
  '',
  'Each command says what it did; with --json it prints that as JSON instead, for scripts.',
].join('\n');

/** How `prepare` names the modules of each convention it counts, one and many. */
const MODULES: Readonly<Record<string, readonly [string, string]>> = {
  routes: ['route', 'routes'],
  mcp: ['MCP tool', 'MCP tools'],
  pages: ['page', 'pages'],
  middleware: ['middleware module', 'middleware modules'],
  crons: ['cron', 'crons'],
  queues: ['queue', 'queues'],
  email: ['email handler', 'email handlers'],
  'durable-objects': ['Durable Object', 'Durable Objects'],
  app: ['app page', 'app pages'],
};

/** The modules `prepare` found, as a person reads them: `5 routes, 1 MCP tool`, or `no modules`. */
function modules(counts: Readonly<Record<string, number>>): string {
  const found = Object.entries(counts).flatMap(([kind, count]) => {
    const [one, many] = MODULES[kind] ?? [kind, kind];
    return count > 0 ? [`${count} ${count === 1 ? one : many}`] : [];
  });
  return found.length ? found.join(', ') : 'no modules';
}

/** A path as the person running the command reads it: relative to where they are. */
function shown(path: string): string {
  return relative(process.cwd(), path) || '.';
}

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
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help) {
    console.info(USAGE);
    return;
  }
  /** Says what the command did: a sentence for a person, or its data as JSON with --json. */
  const report = (data: object, sentence: string) =>
    console.info(values.json ? JSON.stringify(data) : sentence);
  switch (command) {
    case 'init': {
      const [target] = rest;
      if (!target) {
        throw new TypeError('Use maximus init <new-directory> [--name <name>].');
      }
      const { scaffold } = await import('./internal/scaffold.ts');
      const name = values.name ?? basename(resolve(target));
      const created = scaffold(target, name, { mcp: values.mcp, web: values.web });
      const serves = created.mcp ? 'an API and its MCP server' : 'an API';
      report(
        created,
        `Created ${name} in ${shown(created.directory)}/: ${serves}${created.web ? ' with a web app' : ''}.\n${created.next}`
      );
      return;
    }
    case 'gen': {
      const { generateRoute, generateTool } = await import('./internal/generate.ts');
      const [kind, ...args] = rest;
      if (kind === 'route' && args.length === 2) {
        const [method = '', path = ''] = args;
        const route = generateRoute(values.root, method, path, values.tool);
        const tool = values.tool ? `, also the MCP tool ${values.tool}` : '';
        report(route, `Wrote ${shown(route.file)}: ${route.method} ${route.path}${tool}.`);
        return;
      }
      if (kind === 'tool' && args.length === 1) {
        const tool = generateTool(values.root, args[0] ?? '');
        report(tool, `Wrote ${shown(tool.file)}: the MCP tool ${tool.tool}.`);
        return;
      }
      throw new TypeError('Use maximus gen route <method> <path>, or maximus gen tool <name>.');
    }
    case 'skills': {
      const { linkAgentSkills } = await import('./internal/agent-skills.ts');
      const linked = linkAgentSkills(rest[0] ?? '.');
      report(
        { linked },
        linked.length
          ? `Linked the Maximus skill for coding agents: ${linked.join(', ')}.`
          : 'The Maximus skill was already linked for coding agents.'
      );
      return;
    }
    case 'prepare': {
      if (values.mode !== 'production' && values.mode !== 'development') {
        throw new TypeError(
          'Prepare with --mode production, as a build does, or development, as vp dev does.'
        );
      }
      const { prepareConfiguredProject } = await import('./internal/prepare-configured.ts');
      const prepared = await prepareConfiguredProject(rest[0] ?? '.', values.mode);
      const state = prepared.changed ? 'Prepared' : 'Kept';
      report(prepared, `${state} .maximus/ for ${prepared.mode}: ${modules(prepared.modules)}.`);
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
