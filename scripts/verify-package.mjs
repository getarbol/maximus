/**
 * The release checks of the packed packages: every export and the bin are present, the size cap, no private
 * files or workspace protocols, publint's rules, a clean install without optional peers, declarations that
 * type-check without the DOM library, Node and browser entries, Postgres with pg, and `maximus init`
 * service and project starters that pass their own `verify` (types, lint and format, Vite+ build) on the
 * packed release.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { publint } from 'publint';
import { formatMessage } from 'publint/utils';

/** A scratch consumer project, removed at the end. */
const directory = mkdtempSync(join(tmpdir(), 'maximus-consumer-'));
/** The package being released, and its manifest. */
const source = resolve('packages/maximus');
const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf-8'));
/** Runs a script with this Node, in the consumer project unless told otherwise. */
const run = (file, cwd = directory) => execFileSync(process.execPath, [file], { cwd, stdio: 'inherit' });
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
const typecheck = (name, entries, compilerOptions, prelude = '') => {
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
  const packed = JSON.parse(
    execFileSync('tar', ['-xOzf', archive, 'package/package.json'], { encoding: 'utf-8' })
  );
  // Every dependency resolves from the registry: no workspace, file or link protocol reaches a consumer.
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
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

  const install = (dependencies) => {
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ private: true, type: 'module', dependencies })
    );
    execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: directory,
      stdio: 'pipe',
    });
  };
  install({ '@arbol-ai/maximus': archive });
  // Optional peers stay optional: installing Maximus never brings Postgres or the lint toolchain.
  for (const peer of ['pg', 'oxlint', 'oxfmt', 'ultracite']) {
    assert(!existsSync(join(directory, 'node_modules', peer)), `The optional peer ${peer} was installed`);
  }

  // The declarations compile for a Node consumer (no DOM library) and, for the Workers entry and the
  // client a Worker may use, for a Worker consumer. `/postgres` needs @types/pg and the presets their peers.
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
      '/client',
      '/analytics',
      '/testing',
    ],
    { types: ['node'], typeRoots: [resolve('node_modules/@types')] }
  );
  typecheck(
    'workers',
    ['', '/workers', '/mcp', '/client'],
    { types: [] },
    `/// <reference path="${resolve('node_modules/@cloudflare/workers-types/index.d.ts')}" />\n`
  );

  // Every entry that runs outside a Worker loads in Node.
  writeFileSync(
    join(directory, 'node-check.mjs'),
    `import assert from 'node:assert/strict';
import { defineErrors, maximus } from '@arbol-ai/maximus';
import { analytics } from '@arbol-ai/maximus/analytics';
import { createClient } from '@arbol-ai/maximus/client';
import { mcp } from '@arbol-ai/maximus/mcp';
import { mcpToolName, queryKind } from '@arbol-ai/maximus/projection';
import { verifyContract } from '@arbol-ai/maximus/testing';
assert.equal(defineErrors({}).forbidden.create().code, 'FORBIDDEN');
assert.equal(mcpToolName('agenda', { resource: 'appointments', verb: 'findNearest' }), 'agenda_appointments_find_nearest');
assert.equal(queryKind({ type: 'integer' }), 'integer');
for (const value of [maximus, analytics, createClient, mcp, verifyContract]) {
  assert.equal(typeof value, 'function');
}`
  );
  run(join(directory, 'node-check.mjs'));

  // The browser entries reach no Node or Workers module, no MCP SDK and no Postgres driver, however
  // deep the import (a bundler can silently stub a Node built-in, so the graph is read directly).
  const installed = join(directory, 'node_modules/@arbol-ai/maximus');
  const runtimeModule = (specifier) =>
    /^(?:node:|cloudflare:|pg$|@modelcontextprotocol\/)/.test(specifier) ||
    builtinModules.includes(specifier);
  for (const entry of [
    'schemas',
    'errors',
    'failures',
    'body',
    'webhooks',
    'http-paths',
    'projection',
    'client',
  ]) {
    const pending = [join(installed, manifest.exports[`./${entry}`].import)];
    const seen = new Set();
    while (pending.length > 0) {
      const file = pending.pop();
      if (seen.has(file)) {
        continue;
      }
      seen.add(file);
      const text = readFileSync(file, 'utf-8');
      for (const [, specifier] of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)) {
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

  // A starter depends on the release that created it, never on a version pinned in a template.
  const starter = join(directory, 'starter');
  execFileSync(
    process.execPath,
    [
      join(directory, 'node_modules/@arbol-ai/maximus/dist/tooling/cli.js'),
      'init',
      starter,
      '--name',
      'example',
    ],
    { stdio: 'pipe' }
  );
  const starterApp = readFileSync(join(starter, 'src/app.ts'), 'utf-8');
  assert(starterApp.includes('maximus<Env>') && starterApp.includes('issuer:'));
  // A starter runs locally at once: its own random development token, readable only by its owner.
  const devVars = join(starter, '.dev.vars');
  assert.match(readFileSync(devVars, 'utf-8'), /^DEVELOPMENT_TOKEN=[0-9a-f]{64}\n$/);
  assert.equal(statSync(devVars).mode & 0o777, 0o600, 'The development token is readable by others');
  const starterPath = join(starter, 'package.json');
  const starterManifest = JSON.parse(readFileSync(starterPath, 'utf-8'));
  assert.equal(starterManifest.dependencies['@arbol-ai/maximus'], manifest.version);
  assert(!JSON.stringify(starterManifest).includes('@arbol-ai/maximus-'), 'Starter names a retired package');
  assert(!JSON.stringify(starterManifest).includes('wrangler'), 'The starter runs Wrangler');
  assert(readFileSync(join(starter, 'vite.config.ts'), 'utf-8').includes('@arbol-ai/maximus/oxlint'));
  // The starter's own verify, on this release rather than one from the registry: binding and runtime types
  // from cf, its lint and format presets, then Vite+ build.
  starterManifest.dependencies['@arbol-ai/maximus'] = `file:${archive}`;
  writeFileSync(starterPath, `${JSON.stringify(starterManifest, null, 2)}\n`);
  execFileSync('bun', ['install', '--ignore-scripts'], { cwd: starter, stdio: 'pipe' });
  execFileSync('bun', ['run', 'verify'], { cwd: starter, stdio: 'inherit' });
  // cf deploys the build verify left without the development token, which only `cf dev` declares.
  const built = JSON.parse(
    readFileSync(join(starter, '.cloudflare/output/v0/workers/default/worker.config.json'), 'utf-8')
  );
  assert.equal(built.name, 'example');
  assert(
    !JSON.stringify(built).includes('DEVELOPMENT_TOKEN'),
    'A deployed build declares the development token'
  );

  // The project starter, on this release as well: its file routes are discovered, typed through the
  // generated registration and built, and its build carries no development token either.
  const project = join(directory, 'project');
  execFileSync(
    process.execPath,
    [
      join(directory, 'node_modules/@arbol-ai/maximus/dist/tooling/cli.js'),
      'init',
      project,
      '--name',
      'example-project',
      '--layout',
      'project',
    ],
    { stdio: 'pipe' }
  );
  // Its single vite.config.ts needs the Vite plugin, released at the same version and packed the same way.
  const plugin = resolve('packages/vite-plugin');
  const pluginManifest = JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf-8'));
  assert.equal(pluginManifest.version, manifest.version, 'The packages share one version');
  assert.equal(pluginManifest.peerDependencies['@arbol-ai/maximus'], manifest.version);
  execFileSync('bun', ['pm', 'pack', '--destination', directory], { cwd: plugin, stdio: 'pipe' });
  const pluginArchive = join(directory, `arbol-ai-vite-plugin-${pluginManifest.version}.tgz`);
  const packedPlugin = JSON.parse(
    execFileSync('tar', ['-xOzf', pluginArchive, 'package/package.json'], { encoding: 'utf-8' })
  );
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(packedPlugin[section] ?? {})) {
      assert(!/^(?:workspace|file|link):/.test(range), `The plugin's ${section}.${name} is ${range}`);
    }
  }
  const pluginBytes = readFileSync(pluginArchive);
  const pluginLinted = await publint({
    pack: {
      tarball: pluginBytes.buffer.slice(
        pluginBytes.byteOffset,
        pluginBytes.byteOffset + pluginBytes.byteLength
      ),
    },
    strict: true,
  });
  assert.deepEqual(
    pluginLinted.messages.map((message) => formatMessage(message, pluginLinted.pkg, { color: false })),
    [],
    'publint of the plugin'
  );
  const projectPath = join(project, 'package.json');
  const projectManifest = JSON.parse(readFileSync(projectPath, 'utf-8'));
  assert.equal(projectManifest.dependencies['@arbol-ai/maximus'], manifest.version);
  assert.equal(projectManifest.devDependencies['@arbol-ai/vite-plugin'], manifest.version);
  assert(
    !existsSync(join(project, 'cloudflare.config.ts')),
    'The project starter has a cloudflare.config.ts'
  );
  assert(!existsSync(join(project, 'maximus.config.ts')), 'The project starter has a maximus.config.ts');
  projectManifest.dependencies['@arbol-ai/maximus'] = `file:${archive}`;
  projectManifest.devDependencies['@arbol-ai/vite-plugin'] = `file:${pluginArchive}`;
  // The plugin's own dependency on Maximus resolves to this release, not to one from the registry.
  // First, as the formatter sorts the overrides.
  projectManifest.overrides = { '@arbol-ai/maximus': `file:${archive}`, ...projectManifest.overrides };
  writeFileSync(projectPath, `${JSON.stringify(projectManifest, null, 2)}\n`);
  execFileSync('bun', ['install', '--ignore-scripts'], { cwd: project, stdio: 'pipe' });
  execFileSync('bun', ['run', 'verify'], { cwd: project, stdio: 'inherit' });
  assert.match(
    readFileSync(join(project, '.maximus/app.ts'), 'utf-8'),
    /bindRoute\(base, routes_\d+, "\/v1\/greeting", "GET"\)/
  );
  const projectBuild = readFileSync(
    join(project, '.cloudflare/output/v0/workers/default/worker.config.json'),
    'utf-8'
  );
  assert.equal(JSON.parse(projectBuild).name, 'example-project');
  assert(
    !projectBuild.includes('DEVELOPMENT_TOKEN'),
    'A deployed project build declares the development token'
  );
  console.info(
    `Packed packages, their entries and both starters passed (${manifest.name} and ${pluginManifest.name}@${manifest.version}).`
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
