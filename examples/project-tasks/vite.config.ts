/**
 * The only configuration: the application and its Worker. Maximus generates .maximus/ from routes/, mcp/,
 * errors.ts and context.ts, and Cloudflare's Vite plugin builds, runs and deploys the Worker.
 */
import { maximus } from '@arbol-ai/vite-plugin';
import { bindings } from 'cf/config';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [
    maximus({
      name: 'example-tasks',
      namespace: 'tasks',
      title: 'Tasks',
      origin: 'https://tasks.example.com',
      // OAuth access tokens from your authorization server (replace it with yours), which MCP clients
      // discover; `vp dev` also accepts the development token in .dev.vars from localhost.
      tokens: { issuer: 'https://auth.example.com/' },
      compatibilityDate: '2026-10-12',
      env: { TASKS: bindings.kv() },
    }),
  ],
});
