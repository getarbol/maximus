/**
 * The tasks Worker as `cf` develops, builds and deploys it.
 */
import { bindings, defineConfig } from 'cf/config';

export default defineConfig(({ mode }) => ({
  worker: {
    name: 'example-tasks',
    compatibilityDate: '2026-10-12',
    // Maximus keeps per-invocation diagnostics in AsyncLocalStorage (node:async_hooks).
    compatibilityFlags: ['nodejs_compat'],
    // A path, not an imported module: Env is inferred from this file, and the Worker's types need Env.
    entrypoint: './.maximus/entry.ts',
    observability: { enabled: true },
    env: {
      // `cf dev` keeps the tasks locally; `cf deploy` creates the namespace, since this names no id.
      TASKS: bindings.kv(),
      // The development token in .dev.vars, declared for `cf dev` alone: no deployed build carries it.
      DEVELOPMENT_TOKEN: mode === 'development' && bindings.secret(),
    },
  },
}));
