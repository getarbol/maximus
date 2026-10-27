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
/** The widest line the project's formatter writes, in characters. */
const PRINT_WIDTH = 110;
/** The base path a project serves its API below unless its configuration moves it. */
const API_BASE_PATH = '/api';

/** A one-sentence JSDoc comment: on one line when it fits, otherwise wrapped at the formatter's width. */
function jsDoc(sentence: string): string[] {
  const line = `/** ${sentence} */`;
  if (line.length <= PRINT_WIDTH) {
    return [line];
  }
  const lines: string[] = [];
  let current = ' *';
  for (const word of sentence.split(' ')) {
    // A word no line could hold, such as a long path, stays beside the word before it.
    const fitsAlone = ` * ${word}`.length <= PRINT_WIDTH;
    if (current !== ' *' && fitsAlone && `${current} ${word}`.length > PRINT_WIDTH) {
      lines.push(current);
      current = ' *';
    }
    current = `${current} ${word}`;
  }
  return ['/**', ...lines, current, ' */'];
}

/** `head{ a, b }tail`, as the formatter writes it: on one line when it fits, otherwise one entry per line. */
function braces(indent: string, head: string, entries: readonly string[], tail: string): string[] {
  const line = `${indent}${head}{ ${entries.join(', ')} }${tail}`;
  if (line.length <= PRINT_WIDTH) {
    return [line];
  }
  return [`${indent}${head}{`, ...entries.map((entry) => `${indent}  ${entry},`), `${indent}}${tail}`];
}

/** `const { a, b } = input;` as the formatter writes it: it breaks after `=` before it breaks the braces. */
function destructureInput(indent: string, names: readonly string[]): string[] {
  const pattern = `${indent}const { ${names.join(', ')} } =`;
  if (`${pattern} input;`.length <= PRINT_WIDTH) {
    return [`${pattern} input;`];
  }
  if (pattern.length <= PRINT_WIDTH) {
    return [pattern, `${indent}  input;`];
  }
  return braces(indent, 'const ', names, ' = input;');
}

/** A contract field whose value is text, as the formatter writes it: a long text on a line of its own. */
function textField(indent: string, name: string, text: string): string[] {
  const line = `${indent}${name}: '${text}',`;
  if (line.length <= PRINT_WIDTH) {
    return [line];
  }
  return [`${indent}${name}:`, `${indent}  '${text}',`];
}

/**
 * A placeholder handler that answers its input fields back, written as statements: it names the fields it
 * takes, then answers them.
 */
function echoHandler(names: readonly string[]): string[] {
  return [
    '  ({ input }) => {',
    ...destructureInput('    ', names),
    ...braces('    ', 'return ', names, ';'),
    '  },',
  ];
}

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
  const call = `${verb.toUpperCase()} ${API_BASE_PATH}${routePath}`;
  const exposure = tool ? `${call}, also the MCP tool ${tool}` : call;
  const text = [
    `import { defineHandler${parameters.length ? ', t' : ''} } from '@arbol-ai/maximus';`,
    '',
    ...jsDoc(`${exposure}: what it answers, in a few words.`),
    ...routeDeclaration(call, parameters, tool),
    '',
  ].join('\n');
  return { file: writeModule(root, file, text), method: verb.toUpperCase(), path: routePath };
}

/**
 * A route's `defineHandler` call: a placeholder handler that answers its path parameters back, and a
 * contract whose description says what to write there. A route without parameters takes and answers nothing.
 */
function routeDeclaration(call: string, parameters: readonly string[], tool: string | undefined): string[] {
  // The formatter keeps the contract on the line of a handler as short as `() => {}`, and breaks the call
  // around a handler with a body.
  const indent = parameters.length ? '    ' : '  ';
  const fields = parameters.map((parameter) => `${parameter}: t.String()`);
  const contract = [
    ...textField(indent, 'description', `Write one sentence that tells callers what ${call} does.`),
    ...(fields.length ? braces(indent, 'input: ', fields, ',') : []),
    ...(fields.length ? braces(indent, 'output: ', fields, ',') : []),
    ...(tool ? [`${indent}mcp: { name: '${tool}' },`] : []),
  ];
  if (!parameters.length) {
    return ['export default defineHandler(() => {}, {', ...contract, '});'];
  }
  return ['export default defineHandler(', ...echoHandler(parameters), '  {', ...contract, '  }', ');'];
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
    ...jsDoc(`The MCP tool ${tool}, which no HTTP route serves: what it answers, in a few words.`),
    'export default defineTool(',
    ...echoHandler(['text']),
    '  {',
    ...textField('    ', 'description', `Write one sentence that tells agents what ${tool} does.`),
    "    effect: 'read',",
    '    input: { text: t.String({ maxLength: 1000 }) },',
    '    output: { text: t.String() },',
    '  }',
    ');',
    '',
  ].join('\n');
  return { file: writeModule(resolve(directory), join('mcp', 'tools', `${name}.ts`), text), tool };
}
