# Lint and format

New starters use Vite+ by default. Their root `vite.config.ts` owns `lint` and `fmt`; `vp check`
applies the Maximus presets, and the verification task first runs the project's complete TypeScript
check. The framework's root `bun run check` orchestrates workspace TypeScript through `vp run`
and then `vp check`. Existing lint rules stay unchanged during migration; type-aware lint rules
are opt-in rather than silently changing every consumer's policy. `vp pack` builds the package,
and `vp build` builds the Workers. The standalone preset exports below remain available.

Maximus ships an oxlint preset and an oxfmt preset. They are Ultracite's, plus the guardrails a
Maximus service needs: each one stops a mistake that type checking cannot see and that has already
broken, or would quietly weaken, a service. `maximus init` sets both up.

```sh
bun add -d oxlint oxfmt ultracite
```

```ts
// oxlint.config.ts
export { default } from '@arbol-ai/maximus/oxlint';
```

```ts
// oxfmt.config.ts
export { default } from '@arbol-ai/maximus/oxfmt';
```

## The guardrails

| Rule                              | Refuses                             | Why                                                                                                                                      |
| --------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `maximus/no-fetch-redirect-error` | `fetch(url, { redirect: 'error' })` | A Worker's `fetch` throws on it before sending anything, so every such call fails. Use `redirect: 'manual'` and refuse a `3xx` yourself. |
| `no-restricted-properties`        | `process.env`                       | A Worker reads configuration from its `env` bindings and secrets from the Secrets Store (`await env.NAME.get()`).                        |
| `no-restricted-imports`           | `zod`                               | Maximus schemas are TypeBox: `t` from `@arbol-ai/maximus`, or `@arbol-ai/maximus/schemas` in a browser.                                  |
| `no-restricted-imports`           | `hono`, `elysia`                    | Maximus serves HTTP, MCP and RPC from one definition; a second router splits the contract. Use plain routes or mounts.                   |

Code that runs in Node rather than in a Worker may use `redirect: 'error'` and `process.env`: tests
(`tests/`, `*.test.ts`, `*.spec.ts`), `scripts/`, `examples/` and tool configuration
(`*.config.ts`). Tests also relax a few style rules that fight JSON wire assertions.

Build output and generated files are not linted or formatted: `dist`, `.cloudflare` (the Build Output
and the types `cf` writes), `.wrangler` (local state the Workers test pool keeps), `.private`, and the
agent harness folders (`.agents`, `.claude`, `.codex`).

## The rest of the preset

Ultracite's core rules apply, with a few turned off for reasons the preset states beside each one:
definitions keep their semantic key order instead of an alphabetical one, Worker entrypoints and
Durable Objects are classes whose methods need not use `this`, protocol parsers work with ASCII
groups and bits, provider pagination awaits in a loop on purpose, and best-effort cleanup such as
cancelling a body never masks the original failure.

Formatting is Ultracite's with single quotes, 110 columns and prose kept as written.

## Add your framework's rules

Extend the preset with Ultracite's framework presets. oxlint does not inherit `ignorePatterns`
through `extends`, so repeat the preset's:

```ts
// oxlint.config.ts, for a repository with a React app beside the service
import maximus from '@arbol-ai/maximus/oxlint';
import { defineConfig } from 'oxlint';
import react from 'ultracite/oxlint/react';

export default defineConfig({
  extends: [maximus, react],
  ignorePatterns: [...maximus.ignorePatterns, 'apps/app/src/lib/paraglide/**'],
});
```

```ts
// oxfmt.config.ts
import maximus from '@arbol-ai/maximus/oxfmt';
import { defineConfig } from 'oxfmt';

export default defineConfig({
  ...maximus,
  ignorePatterns: [...maximus.ignorePatterns, 'apps/app/src/lib/paraglide/**'],
});
```

To turn a guardrail off for one file, say why in an override:

```ts
overrides: [
  {
    // This module only runs in the CLI, under Node.
    files: ['src/cli/**'],
    rules: { 'maximus/no-fetch-redirect-error': 'off', 'no-restricted-properties': 'off' },
  },
],
```

The `maximus` rules run through oxlint's JavaScript plugin support. Maximus tests the presets against
the oxlint and oxfmt versions it ships with, on every release.
