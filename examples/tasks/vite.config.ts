/**
 * The only configuration: the application, its Worker and its web app. Maximus generates .maximus/ from
 * routes/, mcp/, app/routes/, errors.ts and context.ts, and Cloudflare's Vite plugin builds, runs and deploys
 * the Worker, which serves the API under /api and the React app index.html starts.
 */
import { maximus } from '@arbol-ai/maximus/vite';
import react from '@vitejs/plugin-react';
import { bindings } from 'cf/config';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [
    react(),
    maximus({
      name: 'example-tasks',
      namespace: 'tasks',
      title: 'Tasks',
      // The Worker's workers.dev URL in the account it deploys to.
      origin: `https://example-tasks.${process.env.WORKERS_SUBDOMAIN ?? 'example'}.workers.dev`,
      // OAuth access tokens from your authorization server (replace it with yours), which MCP clients
      // discover; `vp dev` also accepts the development token in .dev.vars from localhost.
      tokens: { issuer: 'https://auth.example.com/' },
      compatibilityDate: '2026-10-26',
      env: { TASKS: bindings.kv() },
    }),
  ],
});
