/**
 * Static assets beyond the common paths: construction refuses unsafe paths, stateful patterns and an
 * origin-wide immutable prefix; patterns admit pages by their source alone; a header policy never replaces
 * the native content type or cache policy; HEAD answers without a body; a missing binding fails loudly.
 */
import { expect, it, vi } from 'vite-plus/test';

import { createHttpHandler, defineErrors, maximus } from '../../src/index.ts';
import { createAssetHandler } from '../../src/workers/assets.ts';
import type { WorkerAssetsOptions } from '../../src/workers/assets.ts';

/** The bindings the policy reads: the build files and a deployment stage. */
interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  STAGE: string;
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

/** A build as the asset server holds it. */
const BUILD: Record<string, { body: string; type: string }> = {
  '/index.html': { body: '<!doctype html>', type: 'text/html' },
  '/app.html': { body: '<!doctype html><main>', type: 'text/html' },
  '/sw.js': { body: 'self.skipWaiting()', type: 'text/javascript' },
  '/assets/app-1a2b.js': { body: 'built code', type: 'text/javascript' },
};
const fetchAsset = vi.fn(async (request: Request) => {
  const file = BUILD[new URL(request.url).pathname];
  return file
    ? new Response(file.body, { headers: { 'content-type': file.type } })
    : new Response('missing', { status: 404 });
});
const env: Env = { ASSETS: { fetch: fetchAsset }, STAGE: 'staging' };
const serve = (options: WorkerAssetsOptions<Env>) =>
  createHttpHandler(app, { fallback: createAssetHandler(options) });
const get = (path: string, init?: RequestInit) => new Request(`https://notes.example.test${path}`, init);

/** A pattern whose own `test` admits every path, whatever its source says. */
class AdmitAll extends RegExp {
  override test(): boolean {
    return true;
  }
}

it('refuses asset paths that are relative, carry a query or a fragment, or hold dot segments', () => {
  const unsafe: WorkerAssetsOptions<Env>[] = [
    { binding: 'ASSETS', pages: { paths: ['settings'] } },
    { binding: 'ASSETS', pages: { paths: ['/settings?tab=team'] } },
    { binding: 'ASSETS', pages: { paths: ['/notes/../admin'] } },
    { binding: 'ASSETS', pages: { paths: ['/settings'], shell: '/index.html#app' } },
    { binding: 'ASSETS', files: ['/./sw.js'] },
    { binding: 'ASSETS', files: ['//cdn.example.test/sw.js'] },
    { binding: 'ASSETS', immutablePrefixes: ['/assets/../'] },
  ];
  for (const options of unsafe) {
    expect(() => createAssetHandler(options)).toThrow(TypeError);
  }
});

it('refuses stateful or foreign page patterns and an immutable prefix that claims the whole origin', () => {
  for (const pattern of [
    /^\/notes\/\w+$/g,
    /^\/notes\/\w+$/y,
    // A caller without types may pass a string where a pattern belongs.
    '^/notes/' as unknown as RegExp,
  ]) {
    expect(() =>
      createAssetHandler<Env>({ binding: 'ASSETS', pages: { paths: [], patterns: [pattern] } })
    ).toThrow(TypeError);
  }
  for (const prefix of ['/', '//']) {
    expect(() => createAssetHandler<Env>({ binding: 'ASSETS', immutablePrefixes: [prefix] })).toThrow(
      TypeError
    );
  }
});

it("admits pages by a pattern's source and flags, never by the pattern object's own methods", async () => {
  fetchAsset.mockClear();
  const handle = serve({
    binding: 'ASSETS',
    pages: { paths: [], patterns: [new AdmitAll('^/notes/[a-z0-9]+$', 'i')], shell: '/app.html' },
  });
  const page = await handle(get('/notes/ABC123'), env);
  expect(await page.text()).toBe('<!doctype html><main>');
  expect(page.headers.get('cache-control')).toBe('no-store');
  expect((await handle(get('/admin'), env)).status).toBe(404);
  expect(fetchAsset.mock.calls.map(([request]) => request.url)).toEqual([
    'https://notes.example.test/app.html',
  ]);
});

it('adds the header policy of each request but never replaces the native content type or cache policy', async () => {
  const policy = vi.fn((_request: Request, deployment: Env) => ({
    'Content-Security-Policy': `default-src 'self'; report-uri /csp/${deployment.STAGE}`,
    'Content-Type': 'text/plain',
    'Cache-Control': 'public, max-age=60',
    'X-Content-Type-Options': 'sniff',
  }));
  const handle = serve({ binding: 'ASSETS', files: ['/sw.js'], headers: policy });
  const file = await handle(get('/sw.js?v=2'), env);
  expect(await file.text()).toBe('self.skipWaiting()');
  expect(file.headers.get('content-security-policy')).toBe("default-src 'self'; report-uri /csp/staging");
  expect(file.headers.get('content-type')).toBe('text/javascript');
  expect(file.headers.get('cache-control')).toBe('no-cache');
  expect(file.headers.get('x-content-type-options')).toBe('nosniff');
  expect(policy).toHaveBeenCalledOnce();
  expect(policy.mock.calls[0]?.[0].url).toBe('https://notes.example.test/sw.js?v=2');
  expect(policy.mock.calls[0]?.[1]).toBe(env);
});

it('keeps an immutable prefix to its own slash-delimited namespace, and never caches a failed answer', async () => {
  fetchAsset.mockClear();
  const handle = serve({ binding: 'ASSETS', immutablePrefixes: ['/assets'] });
  const asset = await handle(get('/assets/app-1a2b.js'), env);
  expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  expect((await handle(get('/assets-legacy/app.js'), env)).status).toBe(404);
  const missing = await handle(get('/assets/missing-9z8y.js'), env);
  expect(missing.status).toBe(404);
  expect(missing.headers.get('cache-control')).toBe('no-store');
  expect(fetchAsset.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual([
    '/assets/app-1a2b.js',
    '/assets/missing-9z8y.js',
  ]);
});

it('answers HEAD with the headers of the asset but no body, and releases the body it fetched', async () => {
  const cancel = vi.fn();
  const fetchWithBody = vi.fn(
    async (_request: Request) =>
      new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'text/javascript' } })
  );
  const file = await serve({ binding: 'ASSETS', files: ['/sw.js'] })(get('/sw.js', { method: 'HEAD' }), {
    ...env,
    ASSETS: { fetch: fetchWithBody },
  });
  expect(file.status).toBe(200);
  expect(file.body).toBeNull();
  expect(file.headers.get('content-type')).toBe('text/javascript');
  expect(fetchWithBody.mock.calls[0]?.[0].method).toBe('HEAD');
  expect(cancel).toHaveBeenCalledOnce();
  // An asset answered without a body has nothing to release.
  const page = await serve({ binding: 'ASSETS', pages: { paths: ['/settings'] } })(
    get('/settings', { method: 'HEAD' }),
    { ...env, ASSETS: { fetch: async () => new Response(null, { status: 200 }) } }
  );
  expect(page.status).toBe(200);
  expect(page.body).toBeNull();
});

it('fails loudly when the configured binding cannot fetch, and never forwards in development without it', async () => {
  // A deployment whose configuration lacks the binding the policy names.
  const misconfigured = { STAGE: 'staging' } as Env;
  const handle = serve({ binding: 'ASSETS', files: ['/sw.js'], development: true });
  const failed = await handle(get('/sw.js'), misconfigured);
  expect(failed.status).toBe(500);
  expect(await failed.json()).toMatchObject({ success: false, error: { code: 'INTERNAL_ERROR' } });
  expect((await handle(get('/src/main.tsx'), misconfigured)).status).toBe(404);
});
