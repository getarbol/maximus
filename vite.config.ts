import { defineConfig } from 'vite-plus';

import fmt from './packages/maximus/config/oxfmt.mjs';
import preset from './packages/maximus/config/oxlint.mjs';

export default defineConfig({
  fmt,
  lint: {
    extends: [preset],
    ignorePatterns: preset.ignorePatterns,
    overrides: [
      {
        // The CLIs run in Node: its fetch honors redirect: 'error', and they read their own environment.
        files: ['packages/maximus/src/tooling/**'],
        rules: { 'maximus/no-fetch-redirect-error': 'off', 'no-restricted-properties': 'off' },
      },
    ],
    // Keep the established lint policy; TypeScript checks every workspace through the root check task.
    options: { typeAware: false },
  },
});
