/**
 * The application: its identity, token policy and error catalog, and the task store every handler
 * receives, scoped to the caller's organization.
 */
import { maximus, ok } from '@arbol-ai/maximus';
import { defineConfig } from '@arbol-ai/maximus/config';

import errors from './errors.ts';
import { taskStore } from './src/tasks.ts';

export default defineConfig({
  application: maximus<Env>({
    name: 'example-tasks',
    namespace: 'tasks',
    title: 'Tasks',
    version: '1.0.0',
    origin: 'https://tasks.example.com',
    // OAuth access tokens from your authorization server (replace the issuer and audience with your own),
    // which MCP clients discover, and from localhost only the development token in .dev.vars.
    tokens: {
      issuer: 'https://auth.example.com/',
      audience: 'https://tasks.example.com',
      development: { binding: 'DEVELOPMENT_TOKEN' },
    },
    errors,
    rpc: { callers: [] },
  }).derive(async ({ env, principal }) => ok({ tasks: taskStore(env.TASKS, principal.organizationId) })),
  worker: { http: { basePath: '/api', healthPath: '/health' } },
});
