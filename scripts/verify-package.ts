/**
 * The release checks of the packed packages: every export and the bin are present, the size cap, no private
 * files or workspace protocols, publint's rules, a clean install without optional peers, declarations that
 * type-check without the DOM library, Node and browser entries, Postgres with pg, and a `maximus init`
 * starter that passes its own `verify` (types, lint and format, Vite+ build) on the packed release.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { publint } from 'publint';
import { formatMessage } from 'publint/utils';

/** What this script reads of a package manifest. */
interface PackageManifest {
  name: string;
  version: string;
  exports: Record<string, Record<string, string>>;
  bin: Record<string, string>;
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
}

/** The manifest a packed tarball carries. */
const packedManifest = (tarball: string): PackageManifest =>
  JSON.parse(
    execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf-8' })
  ) as PackageManifest;

/** A scratch consumer project, removed at the end. */
const directory = mkdtempSync(join(tmpdir(), 'maximus-consumer-'));
/** The package being released, and its manifest. */
const source = resolve('packages/maximus');
const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf-8')) as PackageManifest;
/** Runs a script with this Bun, in the consumer project unless told otherwise. */
const run = (file: string, cwd = directory) =>
  execFileSync(process.execPath, [file], { cwd, stdio: 'inherit' });
/** The strictest compiler options a consumer sets, with every declaration file checked. */
const strictest = {
  strict: true,
  exactOptionalPropertyTypes: true,
  noUncheckedIndexedAccess: true,
  noImplicitOverride: true,
  noPropertyAccessFromIndexSignature: true,
  verbatimModuleSyntax: true,
  skipLibCheck: false,
  noEmit: true,
  target: 'ES2022',
  lib: ['ES2023'],
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
};
/**
 * Type-checks a consumer module that imports the given entries, with this workspace's TypeScript, so a
 * declaration that needs a type its environment lacks fails here rather than in a consumer's build.
 */
const typecheck = (
  name: string,
  entries: readonly string[],
  compilerOptions: Record<string, unknown>,
  prelude = ''
) => {
  const project = join(directory, `types-${name}`);
  mkdirSync(project);
  const imports = entries.map(
    (entry, index) =>
      `import type * as Entry${index} from '@arbol-ai/maximus${entry}';\nexport type { Entry${index} };`
  );
  writeFileSync(join(project, 'check.ts'), `${prelude}${imports.join('\n')}\n`);
  writeFileSync(
    join(project, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { ...strictest, ...compilerOptions }, files: ['check.ts'] })
  );
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', project], {
    stdio: 'inherit',
  });
};
try {
  execFileSync('bun', ['pm', 'pack', '--destination', directory], { cwd: source, stdio: 'pipe' });
  const archive = join(directory, `arbol-ai-maximus-${manifest.version}.tgz`);
  // The bundled entries and their shared chunks, the CLI's templates and the Agent Skill come to about
  // 125 KiB; the cap still catches accidental bundling of dependencies or fixtures, which would
  // multiply it.
  assert(statSync(archive).size < 400 * 1024, 'Package exceeds 400 KiB');
  const files = new Set(execFileSync('tar', ['-tzf', archive], { encoding: 'utf-8' }).split('\n'));
  for (const entry of Object.values(manifest.exports)) {
    for (const target of Object.values(entry)) {
      assert(files.has(`package/${target.slice(2)}`), `Missing export ${target}`);
    }
  }
  for (const target of Object.values(manifest.bin)) {
    assert(files.has(`package/${target}`), `Missing binary ${target}`);
  }
  assert(files.has('package/skills/maximus/SKILL.md'), 'Missing the Agent Skill');
  assert(files.has('package/LICENSE'), 'Missing the license');
  assert(
    ![...files].some((file) => /\.private|\.env|node_modules|^package\/tests\//.test(file)),
    'Private artifacts'
  );
  const packed = packedManifest(archive);
  // Every dependency resolves from the registry: no workspace, file or link protocol reaches a consumer.
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    for (const [name, range] of Object.entries(packed[section] ?? {})) {
      assert(!/^(?:workspace|file|link):/.test(range), `${section}.${name} is ${range} in the release`);
    }
  }
  // publint reads the tarball itself, offline: exports, types, files and fields, warnings as errors.
  const bytes = readFileSync(archive);
  const linted = await publint({
    pack: { tarball: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
    strict: true,
  });
  assert.deepEqual(
    linted.messages.map((message) => formatMessage(message, linted.pkg, { color: false })),
    [],
    'publint'
  );

  /**
   * Installs these packages, tarballs by their path, into the consumer project with Bun, as a project does.
   * Each tarball also overrides its package wherever another one depends on it, so create-maximus's own
   * dependency on Maximus resolves to this release rather than to the registry.
   */
  const install = (dependencies: Record<string, string>) => {
    const specified = Object.fromEntries(
      Object.entries(dependencies).map(([name, range]) => [
        name,
        range.endsWith('.tgz') ? `file:${range}` : range,
      ])
    );
    const overrides = Object.fromEntries(
      Object.entries(specified).filter(([, range]) => range.startsWith('file:'))
    );
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ private: true, type: 'module', dependencies: specified, overrides })
    );
    rmSync(join(directory, 'node_modules'), { recursive: true, force: true });
    rmSync(join(directory, 'bun.lock'), { force: true });
    execFileSync('bun', ['install', '--ignore-scripts', '--linker', 'hoisted'], {
      cwd: directory,
      stdio: 'pipe',
    });
  };
  install({ '@arbol-ai/maximus': archive });
  // Optional peers stay optional: installing Maximus never brings Postgres or the lint toolchain.
  for (const peer of ['pg', 'oxlint', 'oxfmt', 'ultracite']) {
    assert(!existsSync(join(directory, 'node_modules', peer)), `The optional peer ${peer} was installed`);
  }

  // The declarations compile for a Node consumer (no DOM library) and, for the Workers entry and MCP, for a
  // Worker consumer. `/postgres` needs @types/pg and the presets their peers.
  typecheck(
    'node',
    [
      '',
      '/schemas',
      '/errors',
      '/failures',
      '/body',
      '/webhooks',
      '/http-paths',
      '/projection',
      '/diagnostics',
      '/internals',
      '/mcp',
      '/analytics',
      '/testing',
    ],
    { types: ['node'], typeRoots: [resolve('node_modules/@types')] }
  );
  typecheck(
    'workers',
    ['', '/workers', '/mcp'],
    { types: [] },
    `/// <reference path="${resolve('node_modules/@cloudflare/workers-types/index.d.ts')}" />\n`
  );

  // Every entry that runs outside a Worker loads in Node.
  writeFileSync(
    join(directory, 'node-check.mjs'),
    `import assert from 'node:assert/strict';
import { defineErrors, maximus } from '@arbol-ai/maximus';
import { analytics } from '@arbol-ai/maximus/analytics';
import { mcp } from '@arbol-ai/maximus/mcp';
import { mcpToolName, queryKind } from '@arbol-ai/maximus/projection';
import { verifyContract } from '@arbol-ai/maximus/testing';
assert.equal(defineErrors({}).forbidden.create().code, 'FORBIDDEN');
assert.equal(mcpToolName('agenda', { resource: 'appointments', verb: 'findNearest' }), 'agenda_appointments_find_nearest');
assert.equal(queryKind({ type: 'integer' }), 'integer');
for (const value of [maximus, analytics, mcp, verifyContract]) {
  assert.equal(typeof value, 'function');
}`
  );
  run(join(directory, 'node-check.mjs'));

  // The browser entries reach no Node or Workers module, no MCP SDK and no Postgres driver, however
  // deep the import (a bundler can silently stub a Node built-in, so the graph is read directly).
  const installed = join(directory, 'node_modules/@arbol-ai/maximus');
  const runtimeModule = (specifier: string) =>
    /^(?:node:|cloudflare:|pg$|@modelcontextprotocol\/)/.test(specifier) ||
    builtinModules.includes(specifier);
  for (const entry of ['schemas', 'errors', 'failures', 'body', 'webhooks', 'http-paths', 'projection']) {
    const pending = [join(installed, manifest.exports[`./${entry}`]?.import ?? '')];
    const seen = new Set<string>();
    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
      if (seen.has(file)) {
        continue;
      }
      seen.add(file);
      const text = readFileSync(file, 'utf-8');
      for (const [, specifier = ''] of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)) {
        if (specifier.startsWith('.')) {
          pending.push(join(dirname(file), specifier));
        } else {
          assert(!runtimeModule(specifier), `/${entry} reaches ${specifier} through ${file}`);
        }
      }
    }
  }

  // Postgres works once its optional peer is installed.
  install({ '@arbol-ai/maximus': archive, pg: '8.23.1' });
  writeFileSync(
    join(directory, 'postgres-check.mjs'),
    `import assert from 'node:assert/strict';
import { classifyTransactionFailure, withTenantTransaction } from '@arbol-ai/maximus/postgres';
assert.equal(typeof withTenantTransaction, 'function');
assert.equal(classifyTransactionFailure(new Error(), 'commit').code, 'COMMIT_UNCERTAIN');`
  );
  run(join(directory, 'postgres-check.mjs'));

  // The starter, on this release: it depends on the release that created it, never on a version pinned in
  // a template; its file routes are discovered, typed through the generated registration and built; and its
  // build carries no development token.
  const project = join(directory, 'project');
  execFileSync(
    process.execPath,
    [
      join(directory, 'node_modules/@arbol-ai/maximus/dist/tooling/cli.js'),
      'init',
      project,
      '--name',
      'example',
    ],
    { stdio: 'pipe' }
  );
  // A starter runs locally at once: its own random development token, readable only by its owner.
  const devVars = join(project, '.dev.vars');
  assert.match(readFileSync(devVars, 'utf-8'), /^DEVELOPMENT_TOKEN=[0-9a-f]{64}\n$/);
  assert.equal(statSync(devVars).mode & 0o777, 0o600, 'The development token is readable by others');
  const projectPath = join(project, 'package.json');
  const projectManifest = JSON.parse(readFileSync(projectPath, 'utf-8')) as PackageManifest & {
    dependencies: Record<string, string>;
  };
  assert.equal(projectManifest.dependencies['@arbol-ai/maximus'], manifest.version);
  // One package: its vite.config.ts imports the plugin from @arbol-ai/maximus/vite.
  assert(
    !JSON.stringify(projectManifest).includes('@arbol-ai/vite-plugin'),
    'The starter names a second package'
  );
  assert.match(readFileSync(join(project, 'vite.config.ts'), 'utf-8'), /from '@arbol-ai\/maximus\/vite'/);
  assert(!JSON.stringify(projectManifest).includes('wrangler'), 'The starter runs Wrangler');
  assert(!existsSync(join(project, 'cloudflare.config.ts')), 'The starter has a cloudflare.config.ts');
  projectManifest.dependencies['@arbol-ai/maximus'] = `file:${archive}`;
  writeFileSync(projectPath, `${JSON.stringify(projectManifest, null, 2)}\n`);
  execFileSync('bun', ['install', '--ignore-scripts'], { cwd: project, stdio: 'pipe' });
  execFileSync('bun', ['run', 'verify'], { cwd: project, stdio: 'inherit' });
  assert.match(
    readFileSync(join(project, '.maximus/app.ts'), 'utf-8'),
    /bindRoute\(base, route_\d+, "\/v1\/greeting", "GET"\)/
  );
  const projectBuild = readFileSync(
    join(project, '.cloudflare/output/v0/workers/default/worker.config.json'),
    'utf-8'
  );
  assert.equal(JSON.parse(projectBuild).name, 'example');
  assert(
    !projectBuild.includes('DEVELOPMENT_TOKEN'),
    'A deployed project build declares the development token'
  );
  // create-maximus, packed the same way, creates the same starter with the exact release it depends on.
  const create = resolve('packages/create-maximus');
  const createManifest = JSON.parse(readFileSync(join(create, 'package.json'), 'utf-8')) as PackageManifest;
  assert.equal(createManifest.version, manifest.version, 'The packages share one version');
  execFileSync('bun', ['pm', 'pack', '--destination', directory], { cwd: create, stdio: 'pipe' });
  const createArchive = join(directory, `create-maximus-${createManifest.version}.tgz`);
  const packedCreate = packedManifest(createArchive);
  assert.equal(
    packedCreate.dependencies?.['@arbol-ai/maximus'],
    manifest.version,
    'create-maximus pins its release'
  );
  const createBytes = readFileSync(createArchive);
  const createLinted = await publint({
    pack: {
      tarball: createBytes.buffer.slice(
        createBytes.byteOffset,
        createBytes.byteOffset + createBytes.byteLength
      ),
    },
    strict: true,
  });
  assert.deepEqual(
    createLinted.messages.map((message) => formatMessage(message, createLinted.pkg, { color: false })),
    [],
    'publint of create-maximus'
  );
  install({ '@arbol-ai/maximus': archive, 'create-maximus': createArchive });
  execFileSync(
    process.execPath,
    [join(directory, 'node_modules/create-maximus/dist/index.js'), 'created', '--web', '--yes'],
    { cwd: directory, stdio: 'pipe' }
  );
  for (const file of ['routes/v1/greeting.get.ts', 'mcp/instructions.md', 'index.html', '.dev.vars']) {
    assert(existsSync(join(directory, 'created', file)), `create-maximus did not write ${file}`);
  }
  console.info(
    `Packed packages, their entries, the starter and create-maximus passed (${manifest.name} and ${createManifest.name}@${manifest.version}).`
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
