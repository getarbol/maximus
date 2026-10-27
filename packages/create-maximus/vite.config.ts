/**
 * The package's tasks and its build: tsdown, through `vp pack`, bundles the command into one ESM file under
 * dist/.
 */
import { defineConfig } from 'vite-plus';

export default defineConfig({
  // The package's tasks, which `vp run` caches by the files each one reads: an unchanged build replays its
  // dist/ instead of packing again.
  run: {
    tasks: {
      build: { command: 'vp pack', cache: { input: [{ auto: true }, '!dist/**'] } },
      typecheck: 'tsc --noEmit',
    },
  },
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
