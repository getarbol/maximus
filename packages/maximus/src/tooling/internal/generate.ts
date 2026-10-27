/**
 * `maximus gen`: a new route or MCP tool file, named and placed by the conventions prepare reads, with a
 * handler and a contract to fill in. An existing module is never overwritten, and neither is a route a file
 * already answers.
 */
import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { operationPathParameters } from '../../http-paths.ts';
import { checkProjectFolder, projectFiles, projectPath, routeShape } from './project-files.ts';

/** The methods a route file may answer, by the suffix its name takes. */
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
/** A tool's file name, which names it: lowercase words joined by single hyphens. */
const TOOL = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** An MCP tool name a route declares: lowercase words joined by single underscores. */
const TOOL_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/**
 * A route's path as file segments: `/v1/tasks/{taskId}`, `/v1/tasks/:taskId` and `v1/tasks/[taskId]` are
 * `v1`, `tasks` and `[taskId]`. A leading `/api` is the base path, not the route's.
 */
function routeSegments(path: string): string[] {
  const segments = path
    .replace(/^\/?api(?=\/v[1-9])/, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      const parameter =
        /^(?:\{([a-zA-Z][a-zA-Z0-9_]*)\}|:([a-zA-Z][a-zA-Z0-9_]*)|\[([a-zA-Z][a-zA-Z0-9_]*)\])$/.exec(
          segment
        );
      if (parameter) {
        return `[${parameter[1] ?? parameter[2] ?? parameter[3]}]`;
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(segment)) {
        throw new TypeError(
          `Use letters, digits, _ and - in a fixed segment, and {name} for a parameter: ${segment}`
        );
      }
      return segment;
    });
  if (!/^v[1-9][0-9]*$/.test(segments[0] ?? '') || segments.length < 2) {
    throw new TypeError(`A route lives below its API version, such as /v1/tasks: ${path}`);
  }
  return segments;
}

/**
 * Writes a new file of the project, refusing an existing one, a path that leads outside the project and a
 * folder on the way that is a symlink.
 */
function writeModule(root: string, path: string, text: string): string {
  const target = resolve(root, path);
  if (relative(root, target).startsWith('..')) {
    throw new TypeError(`${path} is outside the project.`);
  }
  checkProjectFolder(root, dirname(target));
  if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false })) {
    throw new TypeError(`${path} exists; edit it instead.`);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, { flag: 'wx' });
  return target;
}

/**
 * Writes `routes/<path>.<method>.ts`, or `routes/<path>/index.<method>.ts` when `<path>` is already a folder,
 * declaring a route that takes its path parameters and answers them back, an MCP tool too when `tool` names
 * it. Refuses a method and path a route file already answers.
 */
export function generateRoute(directory: string, method: string, path: string, tool?: string) {
  const root = resolve(directory);
  const verb = method.toLowerCase();
  if (!METHODS.some((known) => known === verb)) {
    throw new TypeError(`Choose a route method: ${METHODS.join(', ')}.`);
  }
  if (tool !== undefined && !TOOL_NAME.test(tool)) {
    throw new TypeError(`Name an MCP tool in snake_case, such as get_task: ${tool}`);
  }
  const segments = routeSegments(path);
  const routePath = projectPath(segments.join('/'), 'routes');
  // The template rules the Worker applies when it starts, such as safe parameter names.
  operationPathParameters(routePath);
  for (const { name, file } of projectFiles(root, 'routes', 'development')) {
    const suffix = /\.(get|post|put|patch|delete)$/.exec(name);
    if (
      suffix?.[1] === verb &&
      routeShape(projectPath(name.slice(0, -suffix[0].length), 'routes')) === routeShape(routePath)
    ) {
      throw new TypeError(`${relative(root, file)} already answers ${verb.toUpperCase()} ${routePath}.`);
    }
  }
  const folder = join('routes', ...segments);
  const file = existsSync(join(root, folder)) ? join(folder, `index.${verb}.ts`) : `${folder}.${verb}.ts`;
  const parameters = segments.flatMap((segment) => (segment.startsWith('[') ? [segment.slice(1, -1)] : []));
  const fields = parameters.map((parameter) => `${parameter}: t.String()`).join(', ');
  const call = `${verb.toUpperCase()} ${routePath}`;
  const contract = [
    `description: 'Describe what ${call} does for its caller.',`,
    ...(parameters.length ? [`input: { ${fields} },`, `output: { ${fields} },`] : []),
    ...(tool ? [`mcp: { name: '${tool}' },`] : []),
  ];
  const handler = parameters.length
    ? `({ input }) => ({ ${parameters.map((parameter) => `${parameter}: input.${parameter}`).join(', ')} })`
    : '() => {}';
  // As the formatter lays a call out: the contract hugged after a handler that fits on the first line.
  const hugged = `export default defineHandler(${handler}, {`;
  const layout =
    hugged.length <= 110
      ? [hugged, ...contract.map((line) => `  ${line}`), '});']
      : [
          'export default defineHandler(',
          `  ${handler},`,
          '  {',
          ...contract.map((line) => `    ${line}`),
          '  }',
          ');',
        ];
  const text = [
    `import { defineHandler${parameters.length ? ', t' : ''} } from '@arbol-ai/maximus';`,
    '',
    `/** ${call} below the API's base path${tool ? `, and the MCP tool ${tool}` : ''}. */`,
    ...layout,
    '',
  ].join('\n');
  return { file: writeModule(root, file, text), method: verb.toUpperCase(), path: routePath };
}

/** Writes `mcp/tools/<name>.ts`, an MCP tool only agents call, named `<name>` in snake_case. */
export function generateTool(directory: string, name: string) {
  if (!TOOL.test(name)) {
    throw new TypeError(`Name a tool file in kebab-case, such as summarize-tasks: ${name}`);
  }
  const tool = name.replaceAll('-', '_');
  const text = [
    "import { defineTool, t } from '@arbol-ai/maximus';",
    '',
    `/** The MCP tool ${tool}: agents call it, and no HTTP route serves it. */`,
    'export default defineTool(({ input }) => ({ text: input.text }), {',
    `  description: 'Describe what ${tool} does for the agent that calls it.',`,
    "  effect: 'read',",
    '  input: { text: t.String({ maxLength: 1000 }) },',
    '  output: { text: t.String() },',
    '});',
    '',
  ].join('\n');
  return { file: writeModule(resolve(directory), join('mcp', 'tools', `${name}.ts`), text), tool };
}
