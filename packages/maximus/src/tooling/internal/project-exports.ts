/** Read public export names with Oxc, without importing or executing application modules. */
import { readFileSync } from 'node:fs';

import { parseSync } from 'vite';

export const ROUTE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Refuse direct runtime import cycles and workerd-only imports in application configuration. */
export function readProjectModule(file: string, role: 'route' | 'middleware' | 'config') {
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
        ['app', 'worker', 'entry'].includes(generated) ||
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

/**
 * A `defineHandler` route or `defineTool` module: one default export, the declaration, and types. Returns
 * whether the declaration names an MCP tool, as its object literal shows it; the generated Worker serves MCP
 * when one does.
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
  const exported = parsed.program.body.find((node) => node.type === 'ExportDefaultDeclaration');
  const declaration = exported?.type === 'ExportDefaultDeclaration' ? exported.declaration : undefined;
  const [argument] = declaration?.type === 'CallExpression' ? declaration.arguments : [];
  return {
    mcp:
      argument?.type === 'ObjectExpression' &&
      argument.properties.some(
        (property) =>
          property.type === 'Property' &&
          ((property.key.type === 'Identifier' && property.key.name === 'mcp') ||
            (property.key.type === 'Literal' && property.key.value === 'mcp'))
      ),
  };
}

/**
 * The schedule a cron module exports, `export const cron = '0 8 * * *'`, when it is a string literal: what
 * a project configured in `vite.config.ts` declares as the Worker's cron trigger. Undefined otherwise.
 */
export function cronExpression(file: string): string | undefined {
  for (const node of readProjectModule(file, 'route').program.body) {
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
