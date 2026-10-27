/**
 * The pricing Worker: it quotes catalog items for the orders Worker, which calls it over native RPC through a
 * Service Binding whose props name it by its service name, `example-orders`. `maximus openapi` writes the RPC
 * document orders binds to, openapi.rpc.json.
 */
import { maximus } from '@arbol-ai/maximus/vite';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [
    maximus({
      name: 'example-pricing',
      namespace: 'pricing',
      title: 'Pricing',
      description: 'Prices catalog items for the services of the account that call it over native RPC.',
      groups: {
        Quotes: 'Quotes of catalog items, in US cents.',
      },
      // The Worker's workers.dev URL in the account it deploys to.
      origin: `https://example-pricing.${process.env.WORKERS_SUBDOMAIN ?? 'example'}.workers.dev`,
      tokens: { issuer: 'https://auth.example.com/' },
      compatibilityDate: '2026-10-26',
      // The services allowed to call the RPC methods, as their Service Bindings' props name them.
      rpc: { callers: ['example-orders'] },
    }),
  ],
});
