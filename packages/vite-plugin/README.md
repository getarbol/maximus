# @arbol-ai/vite-plugin

Maximus for [Vite+](https://viteplus.dev): one `vite.config.ts` configures a Maximus application and the
Cloudflare Worker that serves it.

```sh
bun add @arbol-ai/maximus
bun add -d @arbol-ai/vite-plugin cf vite-plus @cloudflare/workers-types
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
      compatibilityDate: '2026-10-26',
      env: { TASKS: bindings.kv() },
    }),
  ],
});
```

```ts
// routes/v1/tasks/index.get.ts: GET /api/v1/tasks, also the MCP tool list_tasks
import { defineHandler, t } from '@arbol-ai/maximus';

export default defineHandler(
  async ({ env, principal }) => {
    const { keys } = await env.TASKS.list({ prefix: `${principal.organizationId}/` });
    return { tasks: keys.map(({ name }) => name) };
  },
  {
    description: "List the organization's tasks.",
    output: { tasks: t.Array(t.String()) },
    mcp: { name: 'list_tasks' },
  }
);
```

`maximus()` prepares `.maximus/` from `routes/`, `mcp/`, `middleware/` and the other convention
directories before every build and source change, generates `Env` from the bindings, brings the Maximus
lint and format presets unless `vite.config.ts` sets its own, and runs Cloudflare's Vite plugin with the
Worker the options describe: its entry, `nodejs_compat`, the development token in development alone and a
trigger for each cron module. `vp dev` runs it, `vp build` builds it and `cf deploy --prebuilt` deploys it.

With `index.html` at the root, the project is also a web app: the same Worker serves the API under `/api`
and the build, whose React Router pages are the files of `app/routes/`. Add `react()` from
`@vitejs/plugin-react` to the plugins.

`errors.ts`, `context.ts` and `auth.ts` complete the application in code. See the
[project structure](https://github.com/getarbol/maximus/blob/main/docs/guides/project-structure.md) guide.
