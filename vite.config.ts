import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite-plus';

import fmt from './packages/maximus/config/oxfmt.mjs';
import preset from './packages/maximus/config/oxlint.mjs';

/** The packages' source, whose tests must keep at least this share of lines, branches, functions and statements. */
const MINIMUM_COVERAGE = 90;

export default defineConfig({
  fmt,
  lint: {
    extends: [preset],
    ignorePatterns: preset.ignorePatterns,
    overrides: [
      {
        // The CLIs run in Node: its fetch honors redirect: 'error', and they read their own environment.
        files: ['packages/maximus/src/tooling/**', 'packages/vite-plugin/src/**'],
        rules: { 'maximus/no-fetch-redirect-error': 'off', 'no-restricted-properties': 'off' },
      },
    ],
    // Keep the established lint policy; TypeScript checks every workspace through the root check task.
    options: { typeAware: false },
  },
  // Every suite runs from here; tests require an explicit human request, in scripts, hooks and CI alike.
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/tests/**/*.test.ts'],
          exclude: ['packages/*/tests/**/*.integration.test.ts'],
        },
        // Unit tests run the Workers runtime in Node; suites that need workerd use Miniflare.
        resolve: {
          alias: {
            'cloudflare:workers': fileURLToPath(
              new URL('packages/maximus/tests/workers/fixtures/cloudflare-workers.ts', import.meta.url)
            ),
          },
        },
      },
      {
        // Needs Docker and an installed postgres:18.6-trixie image; see docs/guides/postgres.md.
        test: {
          name: 'postgres',
          include: ['packages/maximus/tests/postgres/**/*.integration.test.ts'],
          globalSetup: ['packages/maximus/tests/postgres/local-postgres.ts'],
          testTimeout: 15_000,
          hookTimeout: 30_000,
        },
      },
      {
        // The examples call the built package in Node; their own Vite configuration builds Workers.
        test: { name: 'examples', include: ['examples/*/tests/**/*.test.ts'] },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      thresholds: {
        lines: MINIMUM_COVERAGE,
        branches: MINIMUM_COVERAGE,
        functions: MINIMUM_COVERAGE,
        statements: MINIMUM_COVERAGE,
      },
    },
  },
});
