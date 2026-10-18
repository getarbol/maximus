/**
 * Linting for this repository: the Maximus oxlint preset, with the Node-only rules relaxed for the CLI.
 */
import { defineConfig } from 'oxlint';

import preset from './packages/maximus/config/oxlint.mjs';

export default defineConfig({
  extends: [preset],
  ignorePatterns: preset.ignorePatterns,
  overrides: [
    {
      // The CLIs run in Node: its fetch honors redirect: 'error', and they read their own environment.
      files: ['packages/maximus/src/tooling/**'],
      rules: { 'maximus/no-fetch-redirect-error': 'off', 'no-restricted-properties': 'off' },
    },
  ],
});
