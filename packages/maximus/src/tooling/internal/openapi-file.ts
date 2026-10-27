/**
 * `maximus openapi`: the OpenAPI documents of a project's Worker, as files beside its sources. The HTTP
 * document, the one the Worker serves, is the contract the project's clients are generated from; the RPC
 * document, of the operations it serves over native RPC, is the one other services type their bindings from.
 * `--check` keeps both current in CI.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { AppManifest, OperationShape } from '../../manifest.ts';
import { createRpcOpenApi } from '../../openapi.ts';
import { prepareConfiguredProject } from './prepare-configured.ts';
import { packageDirectory } from './scaffold.ts';

/** The file `maximus openapi` writes the HTTP document to unless `--out` names another, at the project's root. */
export const OPENAPI_FILE = 'openapi.json';

/** What `maximus openapi` did to one document: its file, how many operations it lists, and whether it changed. */
export interface OpenApiFile {
  /** The document's path. */
  file: string;
  /** The operations the document lists. */
  operations: number;
  /** Whether the file was written (or, with `check`, would be) because its text changed. */
  changed: boolean;
}

/** What `maximus openapi` did: the HTTP document, and the RPC document when the Worker serves native RPC. */
export interface OpenApiFiles extends OpenApiFile {
  /** The RPC document, when an operation declares `rpc`. */
  rpc?: OpenApiFile;
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

/** The application a project's generated `.maximus/app.ts` exports. */
interface GeneratedApp {
  app: AppManifest<unknown, unknown, Record<string, OperationShape>>;
}

/**
 * The documents of the project's Worker: the HTTP one it serves at `<basePath>/openapi.json`, and the RPC one
 * of its application. The project is prepared for production, as a build is, and its generated modules run in
 * Node, with `cloudflare:workers` resolved to the stand-in its tests use.
 */
export async function projectDocuments(
  directory: string
): Promise<{ http: Record<string, unknown>; rpc: Record<string, unknown> }> {
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
  const { module: application } = await runnerImport<GeneratedApp>(join(root, '.maximus/app.ts'), options);
  const response = await http.handler(
    new Request(`http://localhost${config.worker.http?.basePath ?? ''}/openapi.json`),
    {}
  );
  if (!response.ok) {
    throw new Error(`The Worker answered its OpenAPI document with ${response.status}.`);
  }
  return {
    http: (await response.json()) as Record<string, unknown>,
    rpc: createRpcOpenApi(application.app),
  };
}

/** How many operations a document lists, across its paths. */
function operationCount(document: Record<string, unknown>): number {
  const paths = (document.paths ?? {}) as Record<string, Record<string, unknown>>;
  return Object.values(paths).reduce((count, methods) => count + Object.keys(methods).length, 0);
}

/** Writes a document to a file as JSON with two-space indentation, unless `check` asks only whether it differs. */
function writeDocument(file: string, document: Record<string, unknown>, check: boolean): OpenApiFile {
  const text = `${JSON.stringify(document, null, 2)}\n`;
  const changed = !existsSync(file) || readFileSync(file, 'utf-8') !== text;
  if (changed && !check) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return { file, operations: operationCount(document), changed };
}

/**
 * Writes the documents of the project's Worker: the HTTP one to `out`, `openapi.json` at its root by default,
 * and, when an operation declares `rpc`, the RPC one beside it, `openapi.rpc.json`. With `check`, writes
 * nothing and answers whether each file differs.
 */
export async function writeOpenApi(
  directory: string,
  { out = OPENAPI_FILE, check = false }: { out?: string; check?: boolean } = {}
): Promise<OpenApiFiles> {
  const documents = await projectDocuments(directory);
  const file = resolve(directory, out);
  const written = writeDocument(file, documents.http, check);
  if (!operationCount(documents.rpc)) {
    return written;
  }
  const rpcFile = file.endsWith('.json') ? `${file.slice(0, -'.json'.length)}.rpc.json` : `${file}.rpc.json`;
  return { ...written, rpc: writeDocument(rpcFile, documents.rpc, check) };
}
