/**
 * The pricing Worker: it quotes catalog items for the orders Worker, which calls it over native RPC through a
 * Service Binding whose props name it `orders`.
 */
import { maximus } from '@arbol-ai/maximus/vite';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [
    maximus({
      name: 'example-pricing',
      namespace: 'pricing',
      title: 'Pricing',
      // The Worker's workers.dev URL in the account it deploys to.
      origin: `https://example-pricing.${process.env.WORKERS_SUBDOMAIN ?? 'example'}.workers.dev`,
      tokens: { issuer: 'https://auth.example.com/' },
      compatibilityDate: '2026-10-26',
      // The deployments allowed to call the RPC methods, as their Service Bindings' props name them.
      rpc: { callers: ['orders'] },
    }),
  ],
});
