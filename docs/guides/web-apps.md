# Web apps

With `index.html` at its root, a project is also a web app: the Worker that serves the API under `/api`
serves a React app beside it, which Vite builds and whose pages are the files of `app/routes/`. This guide
adds the app, writes its pages, calls the API from them, and covers what the Worker answers and the
headers it sends. [`examples/tasks`](../../examples/tasks) is a complete web app.

## Start a web app

`bun create maximus tasks --web` creates a project with the app's files:

```text
index.html              Loads /app/main.tsx
app/main.tsx            Mounts React Router with the routes prepare generates
app/root.tsx            The layout around every page, and what a page that fails shows instead
app/routes/index.tsx    The page at /
```

To add the app to an existing project:

1. Install React and React Router:

   ```sh
   bun add react react-dom react-router
   bun add -d @vitejs/plugin-react @types/react @types/react-dom
   ```

2. Add `react()` to the plugins of `vite.config.ts`:

   ```ts
   // vite.config.ts
   import { maximus } from '@arbol-ai/vite-plugin';
   import react from '@vitejs/plugin-react';
   import { defineConfig } from 'vite-plus';

   export default defineConfig({
     plugins: [
       react(),
       maximus({
         origin: 'https://tasks.example.com',
         tokens: { issuer: 'https://auth.example.com/' },
         compatibilityDate: '2026-10-27',
       }),
     ],
   });
   ```

3. Write `index.html` at the root:

   ```html
   <!doctype html>
   <html lang="en">
     <head>
       <meta charset="utf-8" />
       <meta name="viewport" content="width=device-width, initial-scale=1" />
       <title>Tasks</title>
     </head>
     <body>
       <div id="root"></div>
       <script type="module" src="/app/main.tsx"></script>
     </body>
   </html>
   ```

4. Write `app/main.tsx`, which mounts the routes `maximus prepare` lists in `.maximus/app-routes.ts`:

   ```tsx
   // app/main.tsx
   import { StrictMode } from 'react';
   import { createRoot } from 'react-dom/client';
   import { createBrowserRouter, RouterProvider } from 'react-router';

   import { routes } from '#maximus/app-routes';

   const container = document.querySelector('#root');
   if (!container) {
     throw new Error('index.html needs an element with the id root.');
   }
   createRoot(container).render(
     <StrictMode>
       <RouterProvider router={createBrowserRouter(routes)} />
     </StrictMode>
   );
   ```

5. In `tsconfig.json`, add `"DOM"` and `"DOM.Iterable"` to `lib`, set `"jsx": "react-jsx"` and include
   `app`.

Under `vp dev`, adding or removing `index.html` restarts the server, which then serves the app.

## Write pages

A page is a file of `app/routes/`, named as routes are, with `[name]` for a parameter:

| File                                | Path                          |
| ----------------------------------- | ----------------------------- |
| `app/routes/index.tsx`              | `/`                           |
| `app/routes/tasks/index.tsx`        | `/tasks`                      |
| `app/routes/tasks/[taskId].tsx`     | `/tasks/:taskId`              |
| `app/routes/(account)/settings.tsx` | `/settings`                   |
| `app/routes/debug.dev.tsx`          | `/debug`, under `vp dev` only |
| `app/routes/_format.ts`             | Nothing: a helper             |

A page's default export is its component, and its other exports are what a React Router route module
exports: `loader`, `action`, `ErrorBoundary` and the rest. Each page loads the first time it is visited,
and paths match case-sensitively. Without `app/routes/`, `index.html` is the one page, at `/`.

```tsx
// app/routes/tasks/index.tsx
import { Link, redirect, useLoaderData } from 'react-router';

import { signedIn, tasks } from '../../api.ts';

export async function loader() {
  if (!signedIn()) {
    throw redirect('/');
  }
  return await tasks.list();
}

/** /tasks: the organization's tasks. */
export default function Tasks() {
  const { tasks: list } = useLoaderData<typeof loader>();
  return (
    <ul>
      {list.map((task) => (
        <li key={task.taskId}>
          <Link to={`/tasks/${task.taskId}`}>{task.title}</Link>
        </li>
      ))}
    </ul>
  );
}
```

`app/root.tsx` is the layout around every page: its default export renders the page with `<Outlet />`, and
its `ErrorBoundary` shows when a page fails.

```tsx
// app/root.tsx
import { Outlet } from 'react-router';

export default function Root() {
  return (
    <main>
      <h1>Tasks</h1>
      <Outlet />
    </main>
  );
}

export function ErrorBoundary() {
  return <p role="alert">Something went wrong.</p>;
}
```

## What the Worker answers

Every request reaches the Worker first, and the paths of pages decide what the app answers:

| Request                                                                            | Answer                                                               |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| The API, its OpenAPI document and discovery, `/mcp`, `/health`, a path of `pages/` | As in any project.                                                   |
| A page's path, such as `/`, `/tasks` or `/tasks/9f0c`                              | `index.html`, with `cache-control: no-store`.                        |
| A file of `public/` by its name, such as `/robots.txt`                             | The file, with `cache-control: no-cache`.                            |
| A file of `/assets/`, the build's hashed files                                     | The file, with `cache-control: public, max-age=31536000, immutable`. |
| Any other path, `/index.html` and `/tasks/9f0c/notes` among them                   | `404` with `NOT_FOUND`.                                              |
| A method other than `GET` or `HEAD` on the app's paths                             | `405` with `HTTP_METHOD_NOT_ALLOWED` and `allow: GET, HEAD`.         |

An unknown path is a `404`, never the app, so a mistyped link fails where it is followed. The build's files
are fetched with their path and method alone: no query string and no credential reaches them. Under
`vp dev`, every other `GET` reaches Vite's development server through the same binding, with its headers,
for its client and modules: Vite serves the project's sources there, as any Vite development server does,
and refuses `.env` and `.dev.vars` files. A build forwards nothing else and answers `404`.

Files in `public/` are served at their own names, which use letters, digits, dots, underscores, tildes and
hyphens; dotfiles stay out.

## Call the API

The app calls the API on its own origin with `fetch` and a bearer token, and types each call by the route's
own schemas. Only types cross from the server's modules into the browser's:

```ts
// app/api.ts
import type { Failure, Static } from '@arbol-ai/maximus';

import type { app } from '../.maximus/app.ts';

/** The application's operations, whose schemas type each call. */
type Operations = typeof app.operations;
type Input<K extends keyof Operations> = Static<Operations[K]['input']>;
type Output<K extends keyof Operations> = Static<Operations[K]['output']>;

/** A call the API refused, with the failure it answered. */
export class RefusalError extends Error {
  readonly failure: Failure;
  constructor(failure: Failure) {
    super(failure.message);
    this.name = 'RefusalError';
    this.failure = failure;
  }
}

/** The bearer token the person signed in with, kept in memory alone. */
let token = '';

export function signIn(value: string): void {
  token = value;
}

export function signedIn(): boolean {
  return token !== '';
}

/**
 * Sends one call with the token, and answers its data or throws the failure it answered. Every write sends
 * a JSON body, `{}` when its fields are all in its path.
 */
async function call<K extends keyof Operations>(
  method: string,
  path: string,
  body?: Partial<Input<K>>
): Promise<Output<K>> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  const envelope = (await response.json()) as
    | { success: true; data: Output<K> }
    | { success: false; error: Failure };
  if (!envelope.success) {
    throw new RefusalError(envelope.error);
  }
  return envelope.data;
}

/** A task's path below /api. */
const task = (taskId: string) => `/v1/tasks/${encodeURIComponent(taskId)}`;

/** The organization's tasks, one function per route. */
export const tasks = {
  list: () => call<'getV1Tasks'>('GET', '/v1/tasks'),
  create: (input: Input<'postV1Tasks'>) => call<'postV1Tasks'>('POST', '/v1/tasks', input),
  complete: (taskId: string) => call<'postV1TasksTaskIdComplete'>('POST', `${task(taskId)}/complete`),
};
```

Each operation is named after its route's method and path, as [Concepts](../concepts.md#routes-and-operations)
describes: `GET /v1/tasks` is `getV1Tasks`. Every answer is the envelope described in
[Wire formats](../reference/wire-formats.md), and a refusal carries the failure's `code` to branch on.

The token comes from your authorization server, as the person signs in; never build one into the app. The
default content security policy lets the pages call the token issuer's origin and its token endpoint's. Under
`vp dev`, the development token in `.dev.vars` signs in from `localhost`: the tasks example's first page
asks for it and keeps it in memory, so a reload asks again.

## Headers

The app's pages and files carry these headers by default:

| Header                         | Value                                                                                                                                                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content-security-policy`      | `default-src 'self'; base-uri 'self'; connect-src 'self' <issuer>; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; upgrade-insecure-requests` |
| `strict-transport-security`    | `max-age=31536000; includeSubDomains`                                                                                                                                                                                                                          |
| `cross-origin-opener-policy`   | `same-origin`                                                                                                                                                                                                                                                  |
| `cross-origin-resource-policy` | `same-origin`                                                                                                                                                                                                                                                  |
| `referrer-policy`              | `no-referrer`                                                                                                                                                                                                                                                  |
| `x-frame-options`              | `DENY`                                                                                                                                                                                                                                                         |
| `x-content-type-options`       | `nosniff`                                                                                                                                                                                                                                                      |

`<issuer>` is the origin of `tokens.issuer` and that of its token endpoint, `tokens.tokenEndpoint` or
`oauth/token` below the issuer; without an issuer, `connect-src` is `'self'` alone. Scripts load from the
Worker's origin alone, while `style-src` admits inline styles, which React's `style` attributes need without
a nonce. Under `vp dev` the content security policy and `strict-transport-security` are left out, since
Vite's development client runs inline scripts over plain HTTP.

These headers belong to the app's pages and files. The API answers JSON with its own:
`x-content-type-options: nosniff`, `cache-control: private, no-store` and the request id. A page of
`pages/` that answers HTML sets its own content security policy and the other headers it needs.

`webApp.headers` in `maximus()` changes them. A header it names replaces the default, `false` leaves one
out, and the others stay:

```ts
webApp: {
  headers: { 'permissions-policy': 'camera=(), microphone=()', 'x-frame-options': false },
},
```

A content security policy given there replaces the default whole. `content-type`, `cache-control` and
`x-content-type-options` are always the Worker's own.

## What is refused

| Message                                                                                                                          | When                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `maximus() serves a web app from the root with its hashed files below /assets: keep base and build.assetsDir at their defaults.` | Vite's `base` is not `/`, or `build.assetsDir` is not `assets`.                                                                          |
| `The page <path> claims a path the API, discovery, MCP, the build's assets or pages/ answer: move it in app/routes/.`            | A page at or below the API's base path, `/.well-known`, `/mcp` or `/assets`, at the health path, a versioned path or a path of `pages/`. |
| `Multiple page files claim <path>: <file> and <file>.`                                                                           | Two pages for one path, whatever their parameters are named.                                                                             |
| `app/routes/ holds the pages of a web app: add its index.html at the project root.`                                              | Pages without `index.html`.                                                                                                              |
| `A web app answers at the root: keep the API below http.basePath, /api by default.`                                              | `http.basePath` is `/`.                                                                                                                  |
| `ASSETS serves the web app index.html starts: Maximus declares it.`                                                              | `env` declares a binding named `ASSETS`.                                                                                                 |
| `maximus() configures the assets: index.html at the root makes the project a web app.`                                           | The options set the Worker's `assets`.                                                                                                   |

[Project structure](project-structure.md#what-prepare-refuses) lists the refusals of every other file.
