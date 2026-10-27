/**
 * The check that the OpenAPI documents the examples commit are ones client generators read: each passes
 * Redocly's strictest rules, as `redocly.yaml` states them, and the TypeScript types openapi-typescript writes
 * from it compile under the strictest compiler options. An RPC document lists methods no HTTP server answers,
 * so it has neither servers nor security requirements, and skips the two rules that ask for them.
 *
 * The tools run at the versions pinned here, installed into a directory of their own without install
 * scripts; `OPENAPI_TOOLS` names a directory where they are installed already.
 */
import { execFileSync } from 'node:child_process';
import { globSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** The tools, at the versions the check pins. TypeScript 5 runs openapi-typescript, which uses its API. */
const TOOLS = { '@redocly/cli': '2.71.2', 'openapi-typescript': '7.13.0', typescript: '5.9.3' };

/** The documents the examples commit: each Worker's HTTP document and, beside it, its RPC document. */
const documents = globSync('examples/**/openapi{,.rpc}.json', { exclude: ['**/node_modules/**'] }).toSorted();
if (!documents.length) {
  throw new Error('No example commits an OpenAPI document: run maximus openapi in each example.');
}
const rpcDocuments = documents.filter((file) => file.endsWith('.rpc.json'));
const httpDocuments = documents.filter((file) => !file.endsWith('.rpc.json'));

/** A scratch directory for the tools and the types, removed at the end. */
const scratch = mkdtempSync(join(tmpdir(), 'maximus-clients-'));
/** Runs a command, its output shown, failing the check when it fails. */
const run = (command: string, args: readonly string[], cwd = process.cwd()) =>
  execFileSync(command, args, { cwd, stdio: 'inherit' });

try {
  const tools = process.env.OPENAPI_TOOLS ? resolve(process.env.OPENAPI_TOOLS) : join(scratch, 'tools');
  if (!process.env.OPENAPI_TOOLS) {
    mkdirSync(tools);
    writeFileSync(join(tools, 'package.json'), JSON.stringify({ private: true, dependencies: TOOLS }));
    run('bun', ['install', '--ignore-scripts'], tools);
  }
  const redocly = join(tools, 'node_modules/@redocly/cli/bin/cli.js');
  const openapiTypescript = join(tools, 'node_modules/openapi-typescript/bin/cli.js');

  run('node', [redocly, 'lint', '--config', 'redocly.yaml', ...httpDocuments]);
  if (rpcDocuments.length) {
    run('node', [
      redocly,
      'lint',
      '--config',
      'redocly.yaml',
      '--skip-rule',
      'no-empty-servers',
      '--skip-rule',
      'security-defined',
      ...rpcDocuments,
    ]);
  }

  // Each document's types, named after its file: examples/worker-rpc/pricing/openapi.rpc.json is
  // worker-rpc-pricing-openapi-rpc.ts. They are written from a directory of their own, where no redocly.yaml
  // applies this repository's rules to the generator's own checks.
  const types = join(scratch, 'types');
  mkdirSync(types);
  const files = documents.map((document) => {
    const file = `${document
      .replace(/^examples\//, '')
      .replace(/\.json$/, '')
      .replaceAll(/[/.]/g, '-')}.ts`;
    run('node', [openapiTypescript, resolve(document), '--output', join(types, file)], types);
    return file;
  });
  writeFileSync(
    join(types, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        noPropertyAccessFromIndexSignature: true,
        verbatimModuleSyntax: true,
        skipLibCheck: false,
        noEmit: true,
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        types: [],
      },
      files,
    })
  );
  // The repository's own TypeScript compiles them, as a project that installs Maximus would.
  run(resolve('node_modules/.bin/tsc'), ['-p', join(types, 'tsconfig.json')]);
  console.log(
    `${documents.length} OpenAPI documents pass Redocly's rules, and the types openapi-typescript writes from them compile.`
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
