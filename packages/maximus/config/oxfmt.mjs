/**
 * `@arbol-ai/maximus/oxfmt`: the oxfmt preset for code built on Maximus.
 */
import { defineConfig } from 'oxfmt';
import ultracite from 'ultracite/oxfmt';

/**
 * Formatting for code built on Maximus: Ultracite's, with single quotes and 110 columns, prose kept
 * as written, and generated or vendored files left alone. Use it as is,
 * `export { default } from '@arbol-ai/maximus/oxfmt'`, or spread it and add ignore patterns.
 */
export default defineConfig({
  ...ultracite,
  printWidth: 110,
  singleQuote: true,
  proseWrap: 'preserve',
  ignorePatterns: [
    ...ultracite.ignorePatterns,
    '**/.private/**',
    '**/.cloudflare/**',
    '**/.maximus/**',
    '**/.wrangler/**',
    '**/dist/**',
    '**/openapi*.json',
    '**/.agents/**',
    '**/.claude/**',
    '**/.codex/**',
    'bun.lock',
    'CLAUDE.md',
    'AGENTS.md',
  ],
});
