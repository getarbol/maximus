# Lint and format

Every project lints with the Maximus preset for oxlint and formats with its preset for oxfmt: Ultracite's
rules, plus the guardrails a Maximus service needs. This guide covers how a project gets them, what they
enforce and how to extend them.

## Run them

| Command          | Runs                                                                        |
| ---------------- | --------------------------------------------------------------------------- |
| `bun run check`  | `vp check`: the formatting check, then lint.                                |
| `bun run fix`    | `vp check --fix`: formats the files and applies the fixes lint can make.    |
| `bun run verify` | The types, `vp check`, the tests and the build. CI runs it on every change. |

The starter installs `oxlint`, `oxfmt` and `ultracite` beside Vite+, as optional peers of
`@arbol-ai/maximus`.

## Where the presets come from

`maximus()` brings the presets to the Vite+ configuration that runs it:

- `lint`: `@arbol-ai/maximus/oxlint`, without type-aware rules (`options: { typeAware: false }`), since
  `tsc` checks the types in `bun run typecheck`.
- `fmt`: `@arbol-ai/maximus/oxfmt`.

It brings each one only when `vite.config.ts` does not set it: a configuration with its own `lint` keeps it,
and still receives the `fmt` preset, and the reverse. When oxlint, oxfmt or Ultracite is not installed,
Vite+'s own defaults apply instead; a preset that fails to load for any other reason fails the
configuration, so its guardrails never drop out unnoticed.

## The guardrails

Each guardrail stops a mistake type checking cannot see, and its message says what to do instead:

| Rule                              | Refuses                                   | Because                                                                                                                               |
| --------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `maximus/no-fetch-redirect-error` | `redirect: 'error'` in any object literal | A Worker's `fetch` throws on it before it sends the request. Use `redirect: 'manual'` and refuse a `3xx` answer yourself.             |
| `no-restricted-properties`        | `process.env`                             | A Worker reads its configuration from its `env` bindings, and secrets from Secrets Store (`await env.NAME.get()`).                    |
| `no-restricted-imports`           | `zod`                                     | Maximus schemas are TypeBox: `t` from `@arbol-ai/maximus`, or from `@arbol-ai/maximus/schemas` in a browser.                          |
| `no-restricted-imports`           | `hono`, `elysia`                          | Maximus serves HTTP, MCP and RPC from one definition, and a second router splits the contract. Plain routes or mounts serve the rest. |

Code that runs in Node rather than in a Worker may use `redirect: 'error'` and `process.env`: tests
(`tests/`, `*.test.ts`, `*.spec.ts`), `scripts/`, `examples/` and configuration files (`*.config.ts`), so
`vite.config.ts` can read an id from the environment. Tests also relax a few rules that fight assertions
on JSON and promises: `require-await`, `no-plusplus`, `unicorn/prefer-structured-clone`,
`unicorn/consistent-function-scoping`, `unicorn/no-await-expression-member` and `unicorn/consistent-assert`.

## The rest of the lint preset

The preset is Ultracite's core rules with these changes, each explained beside it in the preset:

- **Definitions keep their order.** `sort-keys` is off: a contract reads in its own order, its input before
  its output.
- **Modules read top-down.** `func-style`, `no-use-before-define`, `no-redeclare` and
  `import/no-named-as-default` are off, for named functions declared below their use and for a value and a
  type of one name, as `Page` is both a schema function and its type, with `unicorn/prefer-export-from`,
  `unicorn/prefer-ternary` and `unicorn/no-useless-undefined`.
- **Workers keep their shapes.** `class-methods-use-this` is off for entrypoints and Durable Objects, whose
  methods need not use `this`; `typescript/consistent-type-definitions`, `typescript/no-empty-interface`
  and `typescript/no-empty-object-type` are off for `Env` and RPC interfaces.
- **Protocol code works with bytes.** `require-unicode-regexp`, `prefer-named-capture-group`,
  `unicorn/prefer-code-point` and `no-bitwise` are off.
- **Some loops are sequential on purpose.** `no-await-in-loop` and `complexity` are off, for paginating a
  provider or retrying one step at a time.
- **Cleanup stays best effort.** `promise/prefer-await-to-then` and `no-empty-function` are off, so cancelling
  a body never masks the original failure; `unicorn/import-style` and
  `unicorn/no-object-as-default-parameter` are off as well, and fetch handlers may be `async`
  (`oxc/no-async-endpoint-handlers`).
- **Route files keep their names.** `unicorn/filename-case` asks for kebab-case, except for a file named by
  its parameter, such as `routes/v1/notes/[noteId].get.ts` or `app/routes/notes/[noteId].tsx`, with or
  without a `.dev` or `.prod` suffix.

Lint leaves out what the project does not write: Ultracite's ignored files (dependencies, builds, coverage,
lockfiles, generated code) and `.cloudflare`, `.maximus`, `.wrangler`, `.private`, `.agents`, `.claude` and
`.codex`.

## The format preset

Formatting is Ultracite's, two spaces, semicolons, trailing commas where ES5 allows them and sorted
imports, with three changes: single quotes, lines of 110 characters, and Markdown prose kept as written
(`proseWrap: 'preserve'`). It leaves alone Ultracite's ignored files and `.private`, `.cloudflare`,
`.maximus`, `.wrangler`, `dist`, `.agents`, `.claude`, `.codex`, `bun.lock`, `CLAUDE.md` and `AGENTS.md`.

## Extend a preset

To change a preset, set `lint` or `fmt` in `vite.config.ts` from the preset: `maximus()` then leaves that one
to you. Extend the lint preset, and repeat its `ignorePatterns`, which oxlint does not carry through
`extends`; spread the format preset:

```ts
// vite.config.ts
import fmt from '@arbol-ai/maximus/oxfmt';
import lint from '@arbol-ai/maximus/oxlint';
import { maximus } from '@arbol-ai/maximus/vite';
import { bindings } from 'cf/config';
import react from 'ultracite/oxlint/react';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  // The Maximus preset and Ultracite's React rules. oxlint does not carry ignorePatterns through extends.
  lint: {
    extends: [lint, react],
    ignorePatterns: [...lint.ignorePatterns, 'app/generated/**'],
    options: { typeAware: false },
  },
  fmt: { ...fmt, ignorePatterns: [...fmt.ignorePatterns, 'app/generated/**'] },
  plugins: [
    maximus({
      origin: 'https://notes.example.com',
      tokens: { issuer: 'https://auth.example.com/' },
      env: { NOTES: bindings.kv() },
      compatibilityDate: '2026-10-27',
    }),
  ],
});
```

To turn a guardrail off for some files, add an override to that `lint`, and say why:

```ts
overrides: [
  {
    // These scripts run in Node, which honors redirect: 'error' and reads its own environment.
    files: ['tools/**'],
    rules: { 'maximus/no-fetch-redirect-error': 'off', 'no-restricted-properties': 'off' },
  },
],
```

The `maximus` rules run through oxlint's JavaScript plugins, which the preset loads itself.
