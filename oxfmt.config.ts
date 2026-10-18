/**
 * Formatting for this repository: the Maximus oxfmt preset, with the hand-edited docs and the generated
 * skill copy left alone.
 */
import { defineConfig } from 'oxfmt';

import preset from './packages/maximus/config/oxfmt.mjs';

export default defineConfig({
  ...preset,
  // Prose in docs/ is edited by hand; the skill copy is generated from .agents/skills.
  ignorePatterns: [
    ...(preset.ignorePatterns ?? []),
    'docs/**',
    'packages/maximus/skills/**',
    'openapi.json',
    'openapi.yml',
  ],
});
