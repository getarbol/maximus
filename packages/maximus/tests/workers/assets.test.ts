/**
 * Static assets: pages, named files and immutable assets each get their policy, and nothing else is
 * served.
 */
import { expect, it, vi } from 'vite-plus/test';

import { createHttpHandler, defineErrors, maximus } from '../../src/index.ts';
import { createAssetHandler } from '../../src/workers/assets.ts';

interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

const app = maximus<Env>({
  name: 'notes',
  namespace: 'notes',
  title: 'Notes',
  version: '1',
  origin: 'https://notes.example.test',
  tokens: { issuer: 'https://issuer.example.test/', audience: 'https://notes.example.test' },
  errors: defineErrors({}),
  rpc: { callers: [] },
  telemetry: { enabled: false },
}).build();

/** A build as the asset server holds it; in development, Vite's dev server stands behind the binding. */
const BUILD: Record<string, string> = {
  '/index.html': '<!doctype html>',
  '/favicon.svg': '<svg/>',
  '/assets/index-1a2b.js': 'built code',
  '/src/main.tsx': 'module source',
};
const fetchAsset = vi.fn(async (request: Request) => {
  const body = BUILD[new URL(request.url).pathname];
  return body === undefined ? new Response('missing', { status: 404 }) : new Response(body);
});
const env: Env = { ASSETS: { fetch: fetchAsset } };
const serve = (development: boolean) =>
  createHttpHandler(app, {
    fallback: createAssetHandler<Env>({
      binding: 'ASSETS',
      pages: { paths: ['/', '/settings'] },
      files: ['/favicon.svg'],
      immutablePrefixes: ['/assets/'],
      headers: { 'content-security-policy': "default-src 'self'" },
      development,
    }),
  });
const get = (path: string) =>
  new Request(`https://notes.example.test${path}`, { headers: { authorization: 'Bearer secret' } });

it('serves its pages, files and immutable assets with their policies, and nothing else', async () => {
  fetchAsset.mockClear();
  const handle = serve(false);
  const page = await handle(get('/settings?tab=team'), env);
  expect(await page.text()).toBe('<!doctype html>');
  expect(page.headers.get('cache-control')).toBe('no-store');
  expect(page.headers.get('content-security-policy')).toBe("default-src 'self'");
  const immutable = await handle(get('/assets/index-1a2b.js'), env);
  expect(immutable.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect((await handle(get('/favicon.svg'), env)).headers.get('cache-control')).toBe('no-cache');
  expect((await handle(get('/src/main.tsx'), env)).status).toBe(404);
  // The asset server receives the selected path alone: no query, no credentials.
  const sent = fetchAsset.mock.calls.map(([request]) => request);
  expect(sent.map((request) => request.url)).toEqual([
    'https://notes.example.test/index.html',
    'https://notes.example.test/assets/index-1a2b.js',
    'https://notes.example.test/favicon.svg',
  ]);
  expect(sent.some((request) => request.headers.has('authorization'))).toBe(false);
});

it("forwards any other GET as it came to Vite's dev server in development, and pages still get the shell", async () => {
  fetchAsset.mockClear();
  const handle = serve(true);
  const module = await handle(get('/src/main.tsx?t=1760000000'), env);
  expect(await module.text()).toBe('module source');
  expect(fetchAsset.mock.calls[0]?.[0].url).toBe('https://notes.example.test/src/main.tsx?t=1760000000');
  expect((await handle(get('/@vite/client'), env)).status).toBe(404);
  const page = await handle(get('/settings'), env);
  expect(page.headers.get('content-security-policy')).toBe("default-src 'self'");
  expect(
    (await handle(new Request('https://notes.example.test/src/main.tsx', { method: 'POST' }), env)).status
  ).toBe(405);
});
