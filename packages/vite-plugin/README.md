# @arbol-ai/vite-plugin

Maximus for [Vite+](https://viteplus.dev): `maximus()` makes one `vite.config.ts` the configuration of a
Maximus application and of the Cloudflare Worker that serves it. `bun create maximus my-api` starts a
project with everything installed; to add it to a Vite+ project:

```sh
bun add @arbol-ai/maximus
bun add -d @arbol-ai/vite-plugin cf @cloudflare/workers-types
```

```ts
// vite.config.ts
import { maximus } from '@arbol-ai/vite-plugin';
import { bindings } from 'cf/config';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [
    maximus({
      origin: 'https://tasks.example.com',
      tokens: { issuer: 'https://auth.example.com/' },
      compatibilityDate: '2026-10-27',
      env: { TASKS: bindings.kv() },
    }),
  ],
});
```

Before every build and on every source change, `maximus()` writes `.maximus/` from the project's files: the
Worker's entry, the application its routes make and an `Env` type inferred from the bindings. It runs
Cloudflare's Vite plugin with the Worker the options describe, which adds `nodejs_compat`, the development
token under `vp dev` alone, a cron trigger for each schedule the cron modules state and a consumer trigger
for each queue module the options do not subscribe themselves. It also brings the Maximus lint and format
presets unless `vite.config.ts` sets its own. `vp dev` runs the Worker, `vp test` runs a project's tests in
Node, `vp build` builds it and `cf deploy --prebuilt` deploys that build.

With `index.html` at the root, the project is also a web app: the same Worker serves the API under `/api`
and a React app whose pages are the files of `app/routes/`.

- [Configuration](https://github.com/getarbol/maximus/blob/main/docs/reference/configuration.md): every
  option of `maximus()`
- [Project structure](https://github.com/getarbol/maximus/blob/main/docs/guides/project-structure.md): the
  files a project holds and what `maximus()` generates from them
- [All documentation](https://github.com/getarbol/maximus/blob/main/docs/README.md)

Released under the MIT License.
