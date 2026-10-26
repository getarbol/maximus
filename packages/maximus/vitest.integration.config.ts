/**
 * Vitest configuration of the Postgres integration tests, which need Docker: `bun run test:integration`.
 */
import { defineConfig } from 'vite-plus/test/config';

export default defineConfig({
  test: {
    include: ['tests/postgres/**/*.integration.test.ts'],
    globalSetup: ['tests/postgres/local-postgres.ts'],
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
