/**
 * The package build: tsdown bundles each entry into one ESM file and one declaration file under dist/,
 * with the code that several entries share in chunks.
 */
import { defineConfig } from 'vite-plus';

/** Every public entry, at the dist path its package.json export names. */
const entries = {
  index: 'src/index.ts',
  schemas: 'src/schemas.ts',
  errors: 'src/errors.ts',
  'standard-failures': 'src/standard-failures.ts',
  body: 'src/body.ts',
  webhooks: 'src/webhooks.ts',
  'http-paths': 'src/http-paths.ts',
  projection: 'src/projection.ts',
  diagnostics: 'src/diagnostics.ts',
  internals: 'src/internals.ts',
  'workers/runtime': 'src/workers/runtime.ts',
  'mcp/index': 'src/mcp/index.ts',
  'client/client': 'src/client/client.ts',
  'analytics/analytics': 'src/analytics/analytics.ts',
  'postgres/index': 'src/postgres/index.ts',
  'tooling/testing': 'src/tooling/testing.ts',
  'project/index': 'src/project/index.ts',
  'project/config': 'src/project/config.ts',
  'tooling/vite': 'src/tooling/vite.ts',
};

/**
 * One build of every entry, so a module shared by several entries is emitted once, in a chunk they
 * all import: its state (TypeBox formats, schema symbols, the telemetry store) exists once. Chunks are
 * split by the entries that use them, so no entry loads code it does not use, and the browser entries
 * never load a chunk that imports node:, cloudflare:, pg or the MCP SDK.
 */
export default defineConfig({
  pack: {
    entry: { ...entries, 'tooling/cli': 'src/tooling/cli.ts' },
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    outDir: 'dist',
    fixedExtension: false,
    sourcemap: false,
    minify: false,
    deps: {
      // Built-ins and the Workers runtime stay imports, like the dependencies and peers.
      neverBundle: [/^node:/, /^cloudflare:/],
      // Nothing from node_modules is bundled, and the output imports nothing the package does not declare.
      onlyBundle: [],
      onlyImport: [
        '@modelcontextprotocol/server',
        '@sinclair/typebox',
        'ajv-formats',
        'jose',
        'yaml',
        'pg',
        'vite',
        /^node:/,
        /^cloudflare:/,
      ],
    },
    dts: {
      generator: 'tsgo',
      tsconfig: 'tsconfig.release.json',
      // The CLI is a binary, not an import: it gets no declarations.
      entry: Object.values(entries),
    },
    outputOptions: {
      // Entries keep their export paths; the shared chunks they import live apart.
      chunkFileNames: 'chunks/[name]-[hash].js',
      codeSplitting: {
        // Declarations used by two or more entries share one file, so a class with a private member
        // (ApplicationBuilder) is a single declaration for every entry.
        groups: [{ name: 'types.d', test: /\.d\.ts$/, minShareCount: 2 }],
      },
    },
  },
});
