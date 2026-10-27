/**
 * `@arbol-ai/maximus/oxlint`: the oxlint preset for code built on Maximus.
 */
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'oxlint';
import core from 'ultracite/oxlint/core';

/** Why an import of another HTTP router is refused. */
const ONE_ROUTER =
  'Maximus serves HTTP, MCP and RPC from one definition; a second router splits the contract. Use plain routes or mounts for anything else.';

/** Files that run outside a Worker: tests, scripts, examples and tool configuration. */
const OUTSIDE_WORKERS = [
  '**/tests/**',
  '**/*.test.{ts,tsx,mts}',
  '**/*.spec.{ts,tsx,mts}',
  '**/scripts/**',
  '**/examples/**',
  '**/*.config.{ts,mts,js,mjs}',
];

/**
 * Lint for code built on Maximus: Ultracite's core rules, the framework's guardrails (each names
 * the mistake it prevents) and the few relaxations Maximus code needs. Use it as is,
 * `export { default } from '@arbol-ai/maximus/oxlint'`, or extend it with your framework's preset.
 * See docs/guides/lint-and-format.md.
 */
export default defineConfig({
  extends: [core],
  jsPlugins: [fileURLToPath(new URL('oxlint-plugin.mjs', import.meta.url))],
  ignorePatterns: [
    ...core.ignorePatterns,
    '**/.cloudflare',
    '**/.maximus',
    '**/.wrangler',
    '**/.private',
    '**/.agents',
    '**/.claude',
    '**/.codex',
  ],
  rules: {
    // Guardrails: each one has broken, or would silently weaken, a Maximus service.
    'maximus/no-fetch-redirect-error': 'error',
    'no-restricted-properties': [
      'error',
      {
        object: 'process',
        property: 'env',
        message:
          'A Worker reads configuration from its env bindings and secrets from the Secrets Store (await env.NAME.get()); process.env is not its configuration.',
      },
    ],
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: 'zod',
            message:
              "Maximus schemas are TypeBox: use t from '@arbol-ai/maximus' ('@arbol-ai/maximus/schemas' in a browser).",
          },
          { name: 'hono', message: ONE_ROUTER },
          { name: 'elysia', message: ONE_ROUTER },
        ],
      },
    ],

    // Fetch handlers are asynchronous by design; this rule is about Express-style servers.
    'oxc/no-async-endpoint-handlers': 'off',
    // Definitions keep their semantic order (scope, title, description, …), not an alphabetical one.
    'eslint/sort-keys': 'off',
    // Named functions, top-down modules, and TypeBox's value-and-type pairs of one name.
    'eslint/func-style': 'off',
    'eslint/no-use-before-define': 'off',
    'eslint/no-redeclare': 'off',
    'import/no-named-as-default': 'off',
    'unicorn/prefer-export-from': 'off',
    'unicorn/prefer-ternary': 'off',
    'unicorn/no-useless-undefined': 'off',
    // Worker entrypoints and Durable Objects are classes whose methods need not touch `this`.
    'eslint/class-methods-use-this': 'off',
    // Env and RPC interfaces, and exact vendor shapes, keep their declared form.
    'typescript/consistent-type-definitions': 'off',
    'typescript/no-empty-interface': 'off',
    'typescript/no-empty-object-type': 'off',
    // Protocol parsers and codecs work with ASCII groups, code units and bits.
    'eslint/require-unicode-regexp': 'off',
    'eslint/prefer-named-capture-group': 'off',
    'unicorn/prefer-code-point': 'off',
    'eslint/no-bitwise': 'off',
    // Paginating a provider or retrying one step at a time is sequential on purpose.
    'eslint/no-await-in-loop': 'off',
    'eslint/complexity': 'off',
    // Best-effort cleanup, such as cancelling a body, must never mask the original failure.
    'promise/prefer-await-to-then': 'off',
    'eslint/no-empty-function': 'off',
    // Node tooling imports stay explicit, and immutable option defaults stay local.
    'unicorn/import-style': 'off',
    'unicorn/no-object-as-default-parameter': 'off',
    // A route file names its path parameter as its input field: `[taskId].get.ts`.
    'unicorn/filename-case': [
      'error',
      {
        case: 'kebabCase',
        ignore: [
          String.raw`^\[[a-z][A-Za-z0-9]*\](?:\.(?:get|post|put|patch|delete))?(?:\.(?:dev|prod))?\.[cm]?[jt]sx?$`,
        ],
      },
    ],
  },
  overrides: [
    {
      files: OUTSIDE_WORKERS,
      rules: {
        // Node runs these: its fetch honors redirect: 'error', and process.env is its configuration.
        'maximus/no-fetch-redirect-error': 'off',
        'no-restricted-properties': 'off',
        // Tests exercise JSON wire behavior and native promise signatures.
        'unicorn/prefer-structured-clone': 'off',
        'unicorn/consistent-function-scoping': 'off',
        'unicorn/no-await-expression-member': 'off',
        'eslint/require-await': 'off',
        'eslint/no-plusplus': 'off',
        'unicorn/consistent-assert': 'off',
      },
    },
  ],
});
