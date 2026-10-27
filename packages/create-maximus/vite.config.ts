/**
 * The package build: tsdown bundles the command into one ESM file under dist/.
 */
import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: { index: 'src/index.ts' },
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    outDir: 'dist',
    fixedExtension: false,
    sourcemap: false,
    minify: false,
    deps: {
      // Nothing from node_modules is bundled: the command runs the CLI of the Maximus release it depends on.
      onlyBundle: [],
      onlyImport: [/^@arbol-ai\/maximus(?:\/|$)/, /^node:/],
    },
    dts: false,
  },
});
