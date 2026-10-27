/**
 * The orders Worker: it quotes orders over HTTP by calling the pricing Worker over native RPC. `services`
 * binds pricing's `Service` entrypoint as PRICING, typed from the RPC document pricing publishes, so orders
 * imports nothing of pricing's project.
 */
import { maximus } from '@arbol-ai/maximus/vite';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [
    maximus({
      name: 'example-orders',
      namespace: 'orders',
      title: 'Orders',
      description: 'Quotes orders, pricing their items with the pricing service over native RPC.',
      groups: {
        Quotes: 'What an order of catalog items would cost. Nothing is reserved or charged.',
      },
      // The Worker's workers.dev URL in the account it deploys to.
      origin: `https://example-orders.${process.env.WORKERS_SUBDOMAIN ?? 'example'}.workers.dev`,
      tokens: { issuer: 'https://auth.example.com/' },
      compatibilityDate: '2026-10-26',
      // Pricing's RPC methods. The binding's props name this service, example-orders, which pricing admits
      // in its rpc.callers; .maximus/services/pricing.ts types the methods from pricing's document.
      services: {
        PRICING: { worker: 'example-pricing', openapi: '../pricing/openapi.rpc.json' },
      },
    }),
  ],
});
