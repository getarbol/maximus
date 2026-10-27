/** Read public export names with Oxc, without importing or executing application modules. */
import { readFileSync } from 'node:fs';

import { parseSync } from 'vite';

export const ROUTE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * Refuse direct runtime import cycles and workerd-only imports in application configuration. A cron module
 * may use the application: only the generated Worker, which imports it, would form a cycle.
 */
export function readProjectModule(file: string, role: 'route' | 'middleware' | 'config' | 'cron') {
  const parsed = parseSync(file, readFileSync(file, 'utf-8'));
  if (parsed.errors.length) {
    throw new TypeError(`Cannot discover ${file}: ${parsed.errors[0]?.message}`);
  }
  for (const node of parsed.program.body) {
    let source: string | undefined;
    if (node.type === 'ImportDeclaration' && node.importKind !== 'type') {
      if (
        node.specifiers.length === 0 ||
        node.specifiers.some(
          (specifier) => specifier.type !== 'ImportSpecifier' || specifier.importKind !== 'type'
        )
      ) {
        source = node.source.value;
      }
    } else if (
      (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') &&
      node.exportKind !== 'type'
    ) {
      source = node.source?.value;
    }
    if (!source) {
      continue;
    }
    const generated = /(?:\.maximus\/|#maximus\/)([^/.?#]+)/.exec(source)?.[1];
    if (
      generated &&
      (role === 'config' ||
        ['worker', 'entry'].includes(generated) ||
        (role !== 'cron' && generated === 'app') ||
        (role === 'middleware' && ['base', 'routes'].includes(generated)))
    ) {
      throw new TypeError(
        `Runtime import ${source} creates a generated-module cycle in ${file}. Use a type-only import or shared domain module.`
      );
    }
    if (
      role === 'config' &&
      (source.startsWith('cloudflare:') || /^@arbol-ai\/maximus\/(?:workers|project)$/.test(source))
    ) {
      throw new TypeError(
        `Configuration must remain importable outside workerd: ${source} in ${file}. Import its types only.`
      );
    }
  }
  return parsed;
}

/** Explicit exports make discovery reproducible; wildcard re-exports have no locally owned method set. */
export function routeExports(file: string): { legacy: boolean; methods: readonly string[] } {
  const parsed = readProjectModule(file, 'route');
  const names = new Set<string>();
  for (const statement of parsed.module.staticExports) {
    for (const entry of statement.entries) {
      if (entry.isType) {
        continue;
      }
      const name = entry.exportName.kind === 'Default' ? 'default' : entry.exportName.name;
      if (!name) {
        throw new TypeError(`Route modules require explicit exports, not export *: ${file}`);
      }
      names.add(name);
    }
  }
  const methods = ROUTE_METHODS.filter((method) => names.has(method));
  if (names.has('default')) {
    if (methods.length) {
      throw new TypeError(`Choose a default route factory or named method exports, not both: ${file}`);
    }
    return { legacy: true, methods: [] };
  }
  const unsupported = [...names].filter((name) => !ROUTE_METHODS.some((method) => method === name));
  if (!methods.length || unsupported.length) {
    throw new TypeError(
      `Route ${file} must export GET, POST, PUT, PATCH or DELETE. Keep helpers private or in _files.`
    );
  }
  return { legacy: false, methods };
}

/** A module's statements, as Oxc parses them. */
type Statement = ReturnType<typeof readProjectModule>['program']['body'][number];
/** What a module may default-export: an expression or declaration, or the initializer of a const it names. */
type Exported =
  | Extract<Statement, { type: 'ExportDefaultDeclaration' }>['declaration']
  | Extract<Statement, { type: 'VariableDeclaration' }>['declarations'][number]['init'];

/** What a module default-exports: `export default x`, or the initializer of the local const it names. */
function defaultExpression(body: readonly Statement[]): Exported | undefined {
  let local: string | undefined;
  let expression: Exported | undefined;
  for (const node of body) {
    if (node.type === 'ExportDefaultDeclaration') {
      if (node.declaration.type === 'Identifier') {
        local = node.declaration.name;
      } else {
        expression = node.declaration;
      }
    } else if (node.type === 'ExportNamedDeclaration' && !node.source) {
      for (const specifier of node.specifiers) {
        const exported = specifier.exported.type === 'Identifier' ? specifier.exported.name : undefined;
        if (exported === 'default' && specifier.local.type === 'Identifier') {
          local = specifier.local.name;
        }
      }
    }
  }
  for (const node of body) {
    const declaration = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
    if (local && declaration?.type === 'VariableDeclaration' && declaration.kind === 'const') {
      for (const declarator of declaration.declarations) {
        if (declarator.id.type === 'Identifier' && declarator.id.name === local) {
          expression = declarator.init;
        }
      }
    }
  }
  return expression;
}

/** An expression without the `as`, `satisfies`, `!` or parentheses around it, which leave its value as it is. */
function unwrap(expression: Exported | undefined): Exported | undefined {
  let current = expression;
  while (
    current?.type === 'TSAsExpression' ||
    current?.type === 'TSSatisfiesExpression' ||
    current?.type === 'TSNonNullExpression' ||
    current?.type === 'ParenthesizedExpression'
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Whether a `defineHandler` call's fields name an MCP tool: true or false as its object literal shows it, or
 * undefined when a spread, a computed key or another argument hides them.
 */
function declaresMcp(expression: Exported | undefined): boolean | undefined {
  const call = unwrap(expression);
  const [first] = call?.type === 'CallExpression' ? call.arguments : [];
  const argument = first?.type === 'SpreadElement' ? undefined : unwrap(first);
  if (argument?.type !== 'ObjectExpression') {
    return undefined;
  }
  let hidden = false;
  for (const property of argument.properties) {
    if (property.type !== 'Property' || (property.computed && property.key.type !== 'Literal')) {
      hidden = true;
    } else if (
      (property.key.type === 'Identifier' && !property.computed && property.key.name === 'mcp') ||
      (property.key.type === 'Literal' && property.key.value === 'mcp')
    ) {
      return true;
    }
  }
  return hidden ? undefined : false;
}

/**
 * A `defineHandler` route or `defineTool` module: one default export, the declaration, and types. Returns
 * whether the declaration names an MCP tool, as its fields show it; the generated Worker serves MCP when one
 * does. A route whose fields prepare cannot see is refused, so a tool is never silently left unserved.
 */
export function declarationExports(file: string, helper: 'defineHandler' | 'defineTool'): { mcp: boolean } {
  const parsed = readProjectModule(file, 'route');
  const names = new Set<string>();
  for (const statement of parsed.module.staticExports) {
    for (const entry of statement.entries) {
      if (!entry.isType) {
        names.add(entry.exportName.kind === 'Default' ? 'default' : (entry.exportName.name ?? '*'));
      }
    }
  }
  if (names.size !== 1 || !names.has('default')) {
    throw new TypeError(
      `${file} must default-export its ${helper} declaration and nothing else. Keep helpers private or in _files.`
    );
  }
  if (helper === 'defineTool') {
    return { mcp: true };
  }
  const mcp = declaresMcp(defaultExpression(parsed.program.body));
  if (mcp === undefined) {
    throw new TypeError(
      `${file} must default-export defineHandler({ ... }) with its fields written in the call, as a const it names or directly: prepare reads from them whether the route is an MCP tool.`
    );
  }
  return { mcp };
}

/**
 * The schedule a cron module exports, `export const cron = '0 8 * * *'`, when it is a string literal: what
 * a project configured in `vite.config.ts` declares as the Worker's cron trigger. Undefined otherwise.
 */
export function cronExpression(file: string): string | undefined {
  for (const node of readProjectModule(file, 'cron').program.body) {
    const declaration = node.type === 'ExportNamedDeclaration' ? node.declaration : undefined;
    if (declaration?.type === 'VariableDeclaration' && declaration.kind === 'const') {
      for (const { id, init } of declaration.declarations) {
        if (id.type === 'Identifier' && id.name === 'cron') {
          return init?.type === 'Literal' && typeof init.value === 'string' ? init.value : undefined;
        }
      }
    }
  }
  return undefined;
}
