/**
 * `maximus openapi`: the OpenAPI document a project's Worker serves, as a file beside its sources. It is the
 * contract the project's clients are generated from and other services bind to, and `--check` keeps it
 * current in CI.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { prepareConfiguredProject } from './prepare-configured.ts';
import { packageDirectory } from './scaffold.ts';

/** The file `maximus openapi` writes and checks unless `--out` names another, at the project's root. */
export const OPENAPI_FILE = 'openapi.json';

/** What `maximus openapi` did: the file, how many operations it documents, and whether it changed. */
export interface OpenApiFile {
  /** The document's path. */
  file: string;
  /** The operations the document lists. */
  operations: number;
  /** Whether the file was written (or, with `check`, would be) because its text changed. */
  changed: boolean;
}

/** The path of this package's stand-in for `cloudflare:workers`: built, or its source in this repository. */
function workersStandIn(): string {
  const own = packageDirectory();
  const built = join(own, 'dist/vite/cloudflare-workers.js');
  return existsSync(built) ? built : join(own, 'src/vite/cloudflare-workers.ts');
}

/** The API a project's generated `.maximus/http.ts` exports. */
interface GeneratedHttp {
  handler: (request: Request, env: object) => Promise<Response>;
}

/** The Worker's settings a project's generated `.maximus/config.ts` exports. */
interface GeneratedConfig {
  worker: { http?: { basePath?: string } };
}

/**
 * The document the project's Worker serves at `<basePath>/openapi.json`: the project is prepared for
 * production, as a build is, and its generated API runs in Node, with `cloudflare:workers` resolved to the
 * stand-in its tests use.
 */
export async function servedOpenApi(directory: string): Promise<Record<string, unknown>> {
  const root = resolve(directory);
  await prepareConfiguredProject(root, 'production');
  const { runnerImport } = await import('vite');
  const options = {
    root,
    configFile: false as const,
    logLevel: 'silent' as const,
    resolve: { alias: { 'cloudflare:workers': workersStandIn() } },
  };
  const { module: config } = await runnerImport<GeneratedConfig>(join(root, '.maximus/config.ts'), options);
  const { module: http } = await runnerImport<GeneratedHttp>(join(root, '.maximus/http.ts'), options);
  const response = await http.handler(
    new Request(`http://localhost${config.worker.http?.basePath ?? ''}/openapi.json`),
    {}
  );
  if (!response.ok) {
    throw new Error(`The Worker answered its OpenAPI document with ${response.status}.`);
  }
  return (await response.json()) as Record<string, unknown>;
}

/** How many operations a document lists, across its paths. */
function operationCount(document: Record<string, unknown>): number {
  const paths = (document.paths ?? {}) as Record<string, Record<string, unknown>>;
  return Object.values(paths).reduce((count, methods) => count + Object.keys(methods).length, 0);
}

/**
 * Writes the document the project's Worker serves to `out`, `openapi.json` at its root by default, as JSON
 * with two-space indentation; with `check`, writes nothing and answers whether the file differs.
 */
export async function writeOpenApi(
  directory: string,
  { out = OPENAPI_FILE, check = false }: { out?: string; check?: boolean } = {}
): Promise<OpenApiFile> {
  const document = await servedOpenApi(directory);
  const file = resolve(directory, out);
  const text = `${JSON.stringify(document, null, 2)}\n`;
  const changed = !existsSync(file) || readFileSync(file, 'utf-8') !== text;
  if (changed && !check) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return { file, operations: operationCount(document), changed };
}
