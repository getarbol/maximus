/**
 * The orders Worker: it quotes orders over HTTP by calling the pricing Worker over native RPC, through a
 * Service Binding whose props name it `orders`, the caller pricing admits.
 */
import { maximus } from '@arbol-ai/vite-plugin';
import { bindings } from 'cf/config';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [
    maximus({
      name: 'example-orders',
      namespace: 'orders',
      title: 'Orders',
      // The Worker's workers.dev URL in the account it deploys to.
      origin: `https://example-orders.${process.env.WORKERS_SUBDOMAIN ?? 'example'}.workers.dev`,
      tokens: { issuer: 'https://auth.example.com/' },
      compatibilityDate: '2026-10-26',
      env: {
        // Pricing's RPC entrypoint. The props belong to this deployment, never to a request, and pricing
        // admits only the callers its `rpc.callers` names. src/pricing.ts types the binding.
        PRICING: bindings.worker({
          worker: 'example-pricing',
          exportName: 'Service',
          props: { caller: 'orders' },
        }),
      },
    }),
  ],
});
