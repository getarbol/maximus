/** Build-time source generation preserves each operation's literal type and keeps filesystem code out of Workers. */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import type { ApplicationConfiguration } from '../../builder.ts';
import { ownsPrefix, VERSIONED_PATH } from '../../internal/http-layout.ts';
import type { TokenPolicy } from '../../tokens.ts';
import { cronExpression, declarationExports, readProjectModule, routeExports } from './project-exports.ts';
import { PROJECT_DIRECTORIES, projectFiles, projectPath, publicFiles } from './project-files.ts';
import { mcpMarkdown } from './project-markdown.ts';

/**
 * A project configured entirely in `vite.config.ts`: the application's configuration besides its code, the
 * Worker's HTTP paths and the bindings of each mode. Every value is plain data, which the generated modules
 * carry; the code that configures the application is `errors.ts`, `auth.ts` and `context.ts`.
 */
export interface ProjectOptions {
  /** Identity, origin, token policy, RPC callers and limits. */
  application: Omit<
    ApplicationConfiguration<unknown>,
    'errors' | 'tokens' | 'telemetry' | 'mcp' | 'rateLimit'
  > & {
    tokens: Omit<TokenPolicy, 'resolve' | 'resources' | 'resourceMetadataUrl'>;
    /** The rate limiting binding's name, which the generated application checks against `Env`. */
    rateLimit?: { binding: string; retryAfter?: number };
  };
  /**
   * The API's base path and the health path the Worker serves, and, for a web app (`index.html` at the
   * project's root), the static assets binding its build is served through.
   */
  worker: { http: { basePath: string; healthPath: string }; assets?: { binding: string } };
  /** The bindings each mode declares, as `cf/config` states them: the generated `Env` is inferred from them. */
  env: { production: Readonly<Record<string, unknown>>; development: Readonly<Record<string, unknown>> };
}

/**
 * The one module of a convention (`maximus.config`, `errors`, `app/root`, …), in any of its extensions, if
 * any.
 */
function rootModule(root: string, name: string, extensions = ['ts', 'mts', 'js', 'mjs']): string | undefined {
  const found = extensions
    .map((extension) => `${name}.${extension}`)
    .filter((file) => existsSync(join(root, file)));
  if (found.length > 1) {
    throw new TypeError(`Keep at most one ${name} module: ${found.join(' or ')}.`);
  }
  const [module] = found;
  if (module && lstatSync(join(root, module)).isSymbolicLink()) {
    throw new TypeError(`The ${name} module cannot be a symlink.`);
  }
  return module;
}

/**
 * Generate only owned modules; a failed discovery never replaces the previous output. `project` holds what
 * `vite.config.ts` configures when neither `maximus.config.ts` nor the 7.3 `src/` entries do.
 */
export function prepareProject(directory: string, mode = 'production', project?: ProjectOptions) {
  const root = resolve(directory);
  const config = rootModule(root, 'maximus.config');
  const legacy =
    !config && existsSync(join(root, 'src/application.ts')) && existsSync(join(root, 'src/worker.ts'));
  if (project && (config || legacy)) {
    throw new TypeError(
      `Configure the application once: in vite.config.ts or in ${config ?? 'src/application.ts'}, not both.`
    );
  }
  for (const required of config || project ? [] : ['src/application.ts', 'src/worker.ts']) {
    if (!existsSync(join(root, required))) {
      throw new TypeError(
        `Configure the application in vite.config.ts with maximus(), or keep the legacy ${required}. Create a project with maximus init --layout project.`
      );
    }
  }
  // A root errors module types every handler's failures; the application must use that same catalog.
  const catalog = rootModule(root, 'errors');
  // vite.config.ts states configuration as data; the code that completes it has its own modules.
  const auth = project && rootModule(root, 'auth');
  const context = project && rootModule(root, 'context');
  for (const name of ['auth', 'context']) {
    if (!project && rootModule(root, name)) {
      throw new TypeError(`${name}.ts completes the application vite.config.ts configures; move it there.`);
    }
  }
  const output = join(root, '.maximus');
  if (existsSync(output) && lstatSync(output).isSymbolicLink()) {
    throw new TypeError('The generated .maximus directory cannot be a symlink.');
  }
  const files = Object.fromEntries(PROJECT_DIRECTORIES.map((name) => [name, projectFiles(root, name, mode)]));
  for (const module of [config, catalog, auth, context]) {
    if (module) {
      readProjectModule(join(root, module), 'config');
    }
  }
  for (const { file } of files.middleware ?? []) {
    readProjectModule(file, 'middleware');
  }
  // Each cron module's schedule, when it states it as a literal: the triggers a project configured in
  // vite.config.ts declares. Read before any output is written, as every module discovery parses.
  const schedules = (files.crons ?? []).map(({ file }) => ({ file, cron: cronExpression(file) }));
  // What mcp/ describes of the MCP server in Markdown: an application vite.config.ts configures takes it,
  // and the others configure `mcp` in code.
  const described = mcpMarkdown(root);
  if (described && !project) {
    throw new TypeError(
      `mcp/*.md describes the MCP server of a project configured in vite.config.ts: set mcp in ${config ?? 'src/application.ts'} instead.`
    );
  }
  const header = `// Generated by maximus prepare (${mode}). Edit the source modules, not this file.\n`;
  const imports: string[] = [];
  const source = (file: string) => JSON.stringify(relative(output, file).split(sep).join('/'));
  const register = (kind: string) =>
    (files[kind] ?? []).map((file, index) => {
      const identifier = `${kind.replaceAll('-', '_')}_${index}`;
      imports.push(`import ${identifier} from ${source(file.file)};`);
      return { ...file, identifier };
    });
  // A path belongs to one unsuffixed module, for every method it exports, or to one suffixed module per
  // method: `tasks/index.get.ts` and `tasks/index.post.ts` share `/v1/tasks`.
  const owners = new Map<string, Map<string, string>>();
  const claim = (path: string, method: string, file: string) => {
    const methods = owners.get(path) ?? new Map<string, string>();
    const owner =
      methods.get(method) ?? methods.get('*') ?? (method === '*' ? [...methods.values()][0] : undefined);
    if (owner) {
      throw new TypeError(
        `Multiple route files claim ${method === '*' ? path : `${method} ${path}`}: ${relative(root, owner)} and ${relative(root, file)}. Put a path's methods in one module, or one method in each suffixed module.`
      );
    }
    owners.set(path, methods.set(method, file));
  };
  const binders = new Set<string>();
  let servesMcp = false;
  const mounts = (files.routes ?? []).flatMap(({ name, file }, index) => {
    const identifier = `routes_${index}`;
    const suffix = /\.(get|post|put|patch|delete)$/.exec(name);
    if (suffix?.[1]) {
      const method = suffix[1].toUpperCase();
      const path = projectPath(name.slice(0, -suffix[0].length), 'routes');
      claim(path, method, file);
      servesMcp = declarationExports(file, 'defineHandler').mcp || servesMcp;
      binders.add('bindRoute');
      imports.push(`import ${identifier} from ${source(file)};`);
      return [`.mount(bindRoute(base, ${identifier}, ${JSON.stringify(path)}, ${JSON.stringify(method)}))`];
    }
    const path = projectPath(name, 'routes');
    claim(path, '*', file);
    const exports = routeExports(file);
    if (exports.legacy) {
      imports.push(`import ${identifier} from ${source(file)};`);
      return [`.mount(${identifier}(${JSON.stringify(path)}))`];
    }
    imports.push(`import * as ${identifier} from ${source(file)};`);
    return exports.methods.map(
      (method) => `.mount(${identifier}.${method}(${JSON.stringify(path)}, ${JSON.stringify(method)}))`
    );
  });
  // A tool only MCP serves is a top-level module of mcp/tools/, named by its file.
  const tools = (files.mcp ?? []).map(({ name, file }, index) => {
    const tool = /^tools\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/.exec(name)?.[1];
    if (!tool) {
      throw new TypeError(
        `MCP modules are kebab-case tools directly in mcp/tools/, such as mcp/tools/summarize-tasks.ts: ${relative(root, file)}`
      );
    }
    declarationExports(file, 'defineTool');
    servesMcp = true;
    binders.add('bindTool');
    imports.push(`import tools_${index} from ${source(file)};`);
    return `.mount(bindTool(base, tools_${index}, ${JSON.stringify(tool)}))`;
  });
  // Instructions, guides and skills describe an MCP server, which the Worker then serves.
  servesMcp ||= described !== undefined;
  const application = `${header}import { ${[...binders, 'checkProjectPipeline'].join(', ')} } from '@arbol-ai/maximus/config';\nimport { base } from './base.ts';\n${imports.join('\n')}\nexport const app = checkProjectPipeline(base, base${mounts.join('')}${tools.join('')}.build());\n`;
  // The bindings, from a source no registered module depends on: `context.ts` and `auth.ts` are typed by
  // them without depending on the base they configure.
  let environment = "Parameters<typeof base.definition.context>[0]['env']";
  let environmentImports = '';
  if (project) {
    environment = 'Env';
  } else if (config) {
    environment = 'ProjectEnv<typeof config>';
    environmentImports = `import type { ProjectEnv } from '@arbol-ai/maximus/config';\nimport type config from '../${config}';\n`;
  }
  const registration = `${header}import type { base } from './base.ts';\n${environmentImports}${catalog ? `import type errors from '../${catalog}';\n` : ''}\ndeclare global {\n  interface MaximusRegister {\n    base: typeof base;\n${catalog ? '    errors: typeof errors;\n' : ''}    env: ${environment};\n  }\n}\n`;
  imports.length = 0;
  const middleware = register('middleware');
  const middlewareSource = `${header}import { collectMiddleware } from '@arbol-ai/maximus/config';\n${imports.join('\n')}\nexport const { middleware, requestMiddleware } = collectMiddleware([${middleware.map(({ identifier }) => identifier).join(', ')}] as const);\n`;
  const configured = config ? 'config.application' : 'application';
  const catalogCheck = catalog
    ? `import errors from '../${catalog}';\nif (${configured}.definition.errors !== errors) {\n  throw new TypeError('The application must use the error catalog ${catalog} exports.');\n}\n`
    : '';
  let baseSource: string;
  if (project) {
    // The application vite.config.ts configures, completed by the optional errors, auth and context modules.
    // defineAuth again: whatever auth.ts exports, only its code joins the configured token policy.
    const tokens = auth ? ', tokens: { ...application.tokens, ...defineAuth(auth) }' : '';
    const prepared = context ? 'bindContext(configured, context)' : 'configured';
    baseSource = `${header}import { ${auth ? 'defineAuth, ' : ''}maximus${catalog ? '' : ', standardErrors'} } from '@arbol-ai/maximus';\nimport { ${context ? 'bindContext, ' : ''}useProjectMiddleware } from '@arbol-ai/maximus/config';\nimport { application } from './config.ts';\nimport { middleware } from './middleware.ts';\n${described ? "import { mcp } from './mcp.ts';\n" : ''}${catalog ? `import errors from '../${catalog}';\n` : ''}${auth ? `import auth from '../${auth}';\n` : ''}${context ? `import context from '../${context}';\n` : ''}const configured = maximus<Env>({ ...application${tokens}, errors${catalog ? '' : ': standardErrors'}${described ? ', mcp' : ''} });\nexport const base = useProjectMiddleware(${prepared}, middleware);\n`;
  } else if (config) {
    baseSource = `${header}import config from '../${config}';\nimport { useProjectMiddleware } from '@arbol-ai/maximus/config';\nimport { middleware } from './middleware.ts';\n${catalogCheck}export const base: typeof config.application = useProjectMiddleware(config.application, middleware);\n`;
  } else {
    baseSource = `${header}import { base as application } from '../src/application.ts';\n${catalogCheck}export const base = application;\n`;
  }
  const routeSource = `${header}import { createRoute } from '@arbol-ai/maximus/config';\nimport { base } from './base.ts';\nexport const defineRoute = createRoute(base);\n`;
  imports.length = 0;
  const pages = register('pages');
  const pagePaths = new Set<string>();
  const pageEntries = pages.map(({ name, identifier }) => {
    const path = projectPath(name, 'pages');
    if (pagePaths.has(path)) {
      throw new TypeError(`Multiple page files claim ${path}.`);
    }
    pagePaths.add(path);
    return `${JSON.stringify(path)}: ${identifier}`;
  });
  const crons = (files.crons ?? []).map(({ file }, index) => {
    imports.push(`import cron_${index}, { cron as schedule_${index} } from ${source(file)};`);
    return `{ cron: schedule_${index}, handler: cron_${index} }`;
  });
  const eventEntries = (kind: 'queues' | 'email') => {
    const keys = new Set<string>();
    return register(kind).map(({ name, identifier }) => {
      if (name.includes('/') || keys.has(name)) {
        throw new TypeError(`${kind} modules require distinct top-level names: ${name}`);
      }
      keys.add(name);
      return `${JSON.stringify(name)}: ${identifier}`;
    });
  };
  const queues = eventEntries('queues');
  const email = eventEntries('email');
  const classes = new Set(['Service']);
  const durableObjects = register('durable-objects').map(({ name, identifier }) => {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
      throw new TypeError(`Durable Object filenames must be top-level kebab-case names: ${name}`);
    }
    const className = name
      .split('-')
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join('');
    if (classes.has(className)) {
      throw new TypeError(`Duplicate Worker export: ${className}`);
    }
    classes.add(className);
    return `export const ${className} = worker.durableObject(${identifier});`;
  });
  // A web app: index.html at the root, which the plugin found, and the pages app/routes/ declares. The same
  // files make React Router's routes and the paths the Worker answers with the app's shell.
  const web = project?.worker.assets;
  if (project && !web && existsSync(join(root, 'app/routes'))) {
    throw new TypeError('app/routes/ holds the pages of a web app: add its index.html at the project root.');
  }
  if (web && existsSync(join(root, 'app')) && lstatSync(join(root, 'app')).isSymbolicLink()) {
    throw new TypeError('Project directory cannot be a symlink: app');
  }
  const appLayout = web ? rootModule(root, 'app/root', ['tsx', 'jsx', 'ts', 'js']) : undefined;
  const appPages = web ? projectFiles(root, 'app/routes', mode) : [];
  // Without app/routes/, index.html is the one page, at the root.
  const shell = { paths: appPages.length ? [] : ['/'], patterns: [] as string[] };
  const claimed = new Map<string, string>();
  const pageRoutes = appPages.map(({ name, file }) => {
    const route = projectPath(name, 'app');
    // `:taskId` and `:id` match the same paths.
    const owner = claimed.get(route.replaceAll(/:[^/]+/g, ':'));
    if (owner) {
      throw new TypeError(
        `Multiple page files claim ${route}: ${relative(root, owner)} and ${relative(root, file)}.`
      );
    }
    claimed.set(route.replaceAll(/:[^/]+/g, ':'), file);
    if (route.includes(':')) {
      shell.patterns.push(`/^${route.replaceAll(/:[^/]+/g, '[^/]+').replaceAll('/', String.raw`\/`)}$/`);
    } else {
      shell.paths.push(route);
    }
    return `{ path: ${JSON.stringify(route)}, caseSensitive: true, lazy: () => import(${source(file)}).then(page) }`;
  });
  if (web && project) {
    const { basePath, healthPath } = project.worker.http;
    if (basePath === '' || basePath === '/') {
      throw new TypeError(
        'A web app answers at the root: keep the API below http.basePath, /api by default.'
      );
    }
    for (const route of [...shell.paths, ...appPages.map(({ name }) => projectPath(name, 'app'))]) {
      if (
        [basePath, '/.well-known', '/mcp', '/assets'].some((prefix) => ownsPrefix(prefix, route)) ||
        route === healthPath ||
        VERSIONED_PATH.test(route) ||
        pagePaths.has(route)
      ) {
        throw new TypeError(
          `The page ${route} claims a path the API, discovery, MCP, the build's assets or pages/ answer: move it in app/routes/.`
        );
      }
    }
  }
  const appRoutes = appPages.length
    ? `${header}import type { ComponentType } from 'react';\nimport type { RouteObject } from 'react-router';\n${appLayout ? `\nimport * as layout from ${source(join(root, appLayout))};\n` : ''}\n/** A page module: its default export renders the page, and its other exports are React Router's. */\nfunction page<Module extends { default: ComponentType }>({ default: Component, ...route }: Module) {\n  return { ...route, Component };\n}\n\n/** The pages app/routes/ declares, each loaded when it is first visited. */\nexport const routes: RouteObject[] = ${appLayout ? `[{ ...page(layout), children: [${pageRoutes.join(', ')}] }]` : `[${pageRoutes.join(', ')}]`};\n`
    : undefined;
  // The build's shell for the pages, public/ by name, the hashed /assets/ for good, and in development,
  // Vite's modules through the binding; a production build forwards nothing else.
  const assetPolicy = web
    ? `, assets: { binding: ${JSON.stringify(web.binding)}, pages: { paths: ${JSON.stringify(shell.paths)}, patterns: [${shell.patterns.join(', ')}] }, files: ${JSON.stringify(web ? publicFiles(root) : [])}, immutablePrefixes: ['/assets'], development: ${mode === 'development'} }`
    : '';
  let optionsImport = "import { options } from '../src/worker.ts';";
  if (project) {
    optionsImport = "import { worker as options } from './config.ts';";
  } else if (config) {
    optionsImport = `import config from '../${config}';\nconst options = config.worker;`;
  }
  // A declared tool needs the MCP transport; a configured one is kept, never doubled.
  const transports = servesMcp
    ? "import { mcp } from '@arbol-ai/maximus/mcp';\nconst transports = options.transports?.some(({ protocol }) => protocol === 'mcp') ? options.transports : [...(options.transports ?? []), mcp()];\n"
    : 'const transports = options.transports;\n';
  const worker = `${header}import { createProjectWorker } from '@arbol-ai/maximus/project';\nimport type { WorkerRuntime } from '@arbol-ai/maximus/workers';\nimport type { ProjectEnv } from '@arbol-ai/maximus/config';\nimport type { base } from './base.ts';\nimport { app } from './app.ts';\n${optionsImport}\nimport { requestMiddleware } from './middleware.ts';\n${imports.join('\n')}\n${transports}const worker: WorkerRuntime<${environment}, typeof app.operations> = createProjectWorker(app, { pages: { ${pageEntries.join(', ')} }, crons: [${crons.join(', ')}], queues: { ${queues.join(', ')} }, email: { ${email.join(', ')} } }, { ...options, transports${assetPolicy}, http: { ...options.http, middleware: [...(options.http?.middleware ?? []), ...requestMiddleware] } });\nexport default worker.handler;\nexport const Service = worker.entrypoint;\n${durableObjects.join('\n')}\n`;
  mkdirSync(output, { recursive: true });
  // What vite.config.ts states, as data the Worker carries, and the bindings `Env` is inferred from by
  // Cloudflare's own inference: a JSON value is also its own literal type.
  const options = project
    ? {
        'config.ts': `${header}import type { WorkerOptions } from '@arbol-ai/maximus/workers';\n\nexport const application = ${JSON.stringify(project.application)} as const;\nexport const worker: WorkerOptions<Env> = ${JSON.stringify({ ...project.worker, assets: undefined })};\n`,
        'env.d.ts': `${header}type Bindings = import('cf/config').InferEnv<\n  { env: ${JSON.stringify(project.env.production)} } | { env: ${JSON.stringify(project.env.development)} }\n>;\n\ndeclare global {\n  namespace Cloudflare {\n    interface Env extends Bindings {}\n  }\n  interface Env extends Cloudflare.Env {}\n}\n\nexport {};\n`,
      }
    : {};
  const generated = {
    ...options,
    'middleware.ts': middlewareSource,
    'base.ts': baseSource,
    'routes.ts': routeSource,
    'register.d.ts': registration,
    'app.ts': application,
    'worker.ts': worker,
    'entry.ts':
      "// Generated by maximus prepare. Stable Cloudflare entrypoint.\nexport { default } from './worker.ts';\nexport * from './worker.ts';\n",
    ...(appRoutes ? { 'app-routes.ts': appRoutes } : {}),
    ...(described
      ? {
          'mcp.ts': `${header}import type { McpConfiguration } from '@arbol-ai/maximus';\n\nexport const mcp: McpConfiguration = ${JSON.stringify(described)};\n`,
        }
      : {}),
  };
  // A module whose sources are gone would import or describe what no longer exists: it goes with them.
  const stale = ['app-routes.ts', 'mcp.ts'].filter(
    (name) => !(name in generated) && existsSync(join(output, name))
  );
  // Validate every destination before replacing any output. A failed discovery keeps the old graph.
  for (const name of [...Object.keys(generated), ...stale]) {
    const target = join(output, name);
    if (existsSync(target) && (lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile())) {
      throw new TypeError(`Generated files must be ordinary files: ${name}`);
    }
  }
  let changed = false;
  for (const [name, content] of Object.entries(generated)) {
    const target = join(output, name);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
      throw new TypeError(`Generated files cannot be symlinks: ${name}`);
    }
    if (!existsSync(target) || readFileSync(target, 'utf-8') !== content) {
      changed = true;
      const temporary = `${target}.${process.pid}.tmp`;
      writeFileSync(temporary, content, { flag: 'wx' });
      renameSync(temporary, target);
    }
  }
  for (const name of stale) {
    rmSync(join(output, name));
    changed = true;
  }
  let layout = 'legacy';
  if (project) {
    layout = 'options';
  } else if (config) {
    layout = 'config';
  }
  return {
    directory: root,
    mode,
    layout,
    changed,
    config,
    durableObjects: files['durable-objects']?.map(({ file }) => file) ?? [],
    crons: schedules,
    // Whether the project is a web app, whose Worker serves its build through the assets binding.
    webApp: Boolean(web),
    files: [
      ...Object.values(files)
        .flat()
        .map(({ file }) => file),
      ...appPages.map(({ file }) => file),
      ...(appLayout ? [join(root, appLayout)] : []),
    ],
    modules: {
      ...Object.fromEntries(Object.entries(files).map(([kind, entries]) => [kind, entries.length])),
      app: appPages.length,
    },
  };
}
