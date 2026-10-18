/**
 * The orders Worker as `cf` develops, builds and deploys it, with its Service Binding to pricing.
 */
import { bindings, defineConfig } from 'cf/config';

import { pricingWorker } from '../pricing/cloudflare.config.ts';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

export default defineConfig(({ mode }) => ({
  worker: {
    name: 'example-orders',
    compatibilityDate: '2026-10-12',
    // Maximus keeps per-invocation diagnostics in AsyncLocalStorage (node:async_hooks).
    compatibilityFlags: ['nodejs_compat'],
    entrypoint,
    observability: { enabled: true },
    env: {
      // Pricing admits only the callers its application lists in `rpc.callers`. The props are set by this
      // deployment's configuration, never by a request.
      PRICING: bindings.worker({
        worker: pricingWorker,
        exportName: 'PricingService',
        props: { caller: 'orders' },
      }),
      // The development token in .dev.vars, declared for `cf dev` alone: no deployed build carries it.
      DEVELOPMENT_TOKEN: mode === 'development' && bindings.secret(),
    },
  },
}));
