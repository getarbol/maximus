/**
 * The pricing Worker as `cf` develops, builds and deploys it, and as the orders Worker binds to it.
 */
import { fileURLToPath } from 'node:url';

import { defineConfig, defineWorker, exports } from 'cf/config';

/** The pricing Worker, which the orders Worker's configuration imports to bind to its entrypoint. */
export const pricingWorker = defineWorker({
  name: 'example-pricing',
  compatibilityDate: '2026-10-12',
  // Maximus keeps per-invocation diagnostics in AsyncLocalStorage (node:async_hooks).
  compatibilityFlags: ['nodejs_compat'],
  // A path rather than a module import, so the orders Worker's Vite build can load this file too.
  entrypoint: fileURLToPath(new URL('src/index.ts', import.meta.url)),
  // Reached only through Service Bindings: no public hostname.
  workersDev: false,
  previewUrls: false,
  observability: { enabled: true },
  exports: { PricingService: exports.worker() },
});

export default defineConfig({ worker: pricingWorker });
