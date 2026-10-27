/**
 * The package build: tsdown bundles the plugin into one ESM file and one declaration file under dist/, and
 * the stand-in for `cloudflare:workers` that a project's tests resolve into dist/testing/.
 */
import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: { index: 'src/index.ts', 'testing/cloudflare-workers': 'src/testing/cloudflare-workers.ts' },
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    outDir: 'dist',
    fixedExtension: false,
    sourcemap: false,
    minify: false,
    deps: {
      // Nothing from node_modules is bundled, and the output imports nothing the package does not declare.
      onlyBundle: [],
      onlyImport: [/^@arbol-ai\/maximus(?:\/|$)/, '@cloudflare/vite-plugin', 'cf', 'vite', /^node:/],
    },
    dts: { generator: 'tsgo', tsconfig: 'tsconfig.release.json' },
  },
});
