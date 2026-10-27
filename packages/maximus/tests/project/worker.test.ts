/**
 * createProjectWorker, the Worker a project's generated code composes: pages answer GET and HEAD at fixed paths
 * outside the API, other unmatched paths reach the fallback, the static assets or NOT_FOUND, a page path the
 * API, discovery, plain routes, mounts or transports own is refused, and discovered event modules become the
 * Worker's own handlers.
 */
import { describe, expect, it, vi } from 'vite-plus/test';

import { defineErrors, maximus, ok, t } from '../../src/index.ts';
import type { HttpRoute } from '../../src/index.ts';
import { mcp } from '../../src/mcp/index.ts';
import { createProjectWorker } from '../../src/project/index.ts';
import type { ProjectModules } from '../../src/project/index.ts';
import type { WorkerOptions } from '../../src/workers/runtime.ts';

interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

const app = maximus<Env>({
  name: 'clinic',
  namespace: 'clinic',
  title: 'Clinic',
  version: '1',
  origin: 'https://clinic.example.test',
  tokens: { issuer: 'https://issuer.example.test/', audience: 'https://clinic.example.test' },
  errors: defineErrors({}),
  rpc: { callers: [] },
  telemetry: { enabled: false },
})
  .operation(
    'listSlots',
    {
      scope: 'clinic:slots:read',
      title: 'List slots',
      description: 'List the open appointment slots.',
      effect: 'read',
      input: t.Object({}, { additionalProperties: false }),
      output: t.Object({ slots: t.Array(t.String()) }, { additionalProperties: false }),
      http: { method: 'GET', path: '/v1/slots' },
    },
    async () => ok({ slots: [] })
  )
  .build();

const assets = vi.fn(async (request: Request) => new Response(`asset ${new URL(request.url).pathname}`));
const env: Env = { ASSETS: { fetch: assets } };
const background = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;

/** A page that answers with its own markup and records the method it received. */
function page(markup: string) {
  const methods: string[] = [];
  const route: HttpRoute<Env> = async (request) => {
    methods.push(request.method);
    return new Response(markup, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  return { route, methods };
}

/** Sends one request to the Worker's fetch handler. */
async function send(
  modules: ProjectModules<Env>,
  options: WorkerOptions<Env>,
  method: string,
  path: string
): Promise<Response> {
  const { fetch } = createProjectWorker(app, modules, options).handler;
  if (!fetch) {
    throw new TypeError('The project Worker has no fetch handler.');
  }
  const incoming = new Request(`https://clinic.example.test${path}`, { method });
  return fetch(incoming as Request<unknown, IncomingRequestCfProperties>, env, background);
}

const API = { http: { basePath: '/api' } };

describe('pages', () => {
  it('answer GET at their path, and HEAD with the same head and no body', async () => {
    const home = page('<h1>Hello World</h1>');
    const about = page('<h1>About</h1>');
    const pages = { '/': home.route, '/about': about.route };
    const got = await send({ pages }, API, 'GET', '/');
    expect(got.status).toBe(200);
    expect(await got.text()).toBe('<h1>Hello World</h1>');
    // Native handling still applies around a page.
    expect(got.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const head = await send({ pages }, API, 'HEAD', '/about');
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await head.text()).toBe('');
    expect(about.methods).toEqual(['HEAD']);
  });

  it('refuse any other method with 405 and the methods they allow, without running', async () => {
    const about = page('<h1>About</h1>');
    const response = await send({ pages: { '/about': about.route } }, API, 'POST', '/about');
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: 'HTTP_METHOD_NOT_ALLOWED' },
    });
    expect(about.methods).toEqual([]);
  });

  it('leave the API, its health check and its operations to the native pipeline', async () => {
    const home = page('<h1>Hello World</h1>');
    const pages = { '/': home.route };
    expect(await (await send({ pages }, API, 'GET', '/api/health')).json()).toMatchObject({
      status: 'ok',
      service: 'clinic',
    });
    // The operation is matched and admits no anonymous caller.
    expect((await send({ pages }, API, 'GET', '/api/v1/slots')).status).toBe(401);
    expect(home.methods).toEqual([]);
  });
});

describe('an unmatched path', () => {
  it('reaches the HTTP fallback when there is one, and is NOT_FOUND otherwise', async () => {
    const fallback = vi.fn<HttpRoute<Env>>(async () => new Response('fallback'));
    const pages = { '/': page('<h1>Hello World</h1>').route };
    const reached = await send({ pages }, { http: { basePath: '/api', fallback } }, 'GET', '/pricing');
    expect(await reached.text()).toBe('fallback');
    expect(fallback).toHaveBeenCalledOnce();
    const missing = await send({}, API, 'GET', '/pricing');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('is served from the static assets, which no page can lose a path to', async () => {
    assets.mockClear();
    const options = { ...API, assets: { binding: 'ASSETS', files: ['/favicon.svg', '/'] } } as const;
    const pages = { '/': page('<h1>Hello World</h1>').route };
    expect(await (await send({ pages }, options, 'GET', '/favicon.svg')).text()).toBe('asset /favicon.svg');
    expect(await (await send({ pages }, options, 'GET', '/')).text()).toBe('<h1>Hello World</h1>');
    expect(assets.mock.calls.map(([sent]) => new URL(sent.url).pathname)).toEqual(['/favicon.svg']);
  });
});

it('refuses static assets beside an HTTP fallback: one owner answers unmatched paths', () => {
  expect(() =>
    createProjectWorker(
      app,
      {},
      { assets: { binding: 'ASSETS' }, http: { fallback: async () => new Response() } }
    )
  ).toThrow(new TypeError('Worker assets and an HTTP fallback cannot both own unmatched paths.'));
});

it('refuses a page path the API, discovery, a plain route, a mount or a transport owns, or a malformed one', () => {
  const route: HttpRoute<Env> = async () => new Response('page');
  const refused: [string, WorkerOptions<Env>][] = [
    // Malformed: relative, a trailing slash, a reserved character and dot segments.
    ['about', API],
    ['/about/', API],
    ['/about us', API],
    ['/notes/../admin', API],
    ['/.', API],
    // The API's own paths: the root and discovery without a base path, the base path and below it.
    ['/', {}],
    ['/openapi.json', {}],
    ['/status', { http: { basePath: '/api', healthPath: '/status' } }],
    ['/api', API],
    ['/api/docs', API],
    // Versioned operation paths and discovery documents, wherever the API lives.
    ['/v1', API],
    ['/v2/slots', API],
    ['/.well-known/security.txt', API],
    // What the Worker's options already route.
    ['/webhooks/stripe', { ...API, routes: { '/webhooks/stripe': route } }],
    ['/auth/callback', { http: { basePath: '/api', mounts: { '/auth': route } } }],
    ['/mcp', { ...API, transports: [mcp()] }],
  ];
  for (const [path, options] of refused) {
    expect(() => createProjectWorker(app, { pages: { [path]: route } }, options), path).toThrow(
      new TypeError(`Page path is reserved or malformed: ${path}. Move the API with http.basePath.`)
    );
  }
  // Beside them, ordinary paths remain pages.
  expect(() =>
    createProjectWorker(app, { pages: { '/': route, '/about': route, '/v': route, '/api-docs': route } }, API)
  ).not.toThrow();
});

it("makes discovered crons, queues and email the Worker's handlers, beside its explicit fallbacks", async () => {
  const daily = vi.fn(async () => undefined);
  const scheduled = vi.fn(async () => undefined);
  const reminders = vi.fn(async () => undefined);
  const { handler } = createProjectWorker(
    app,
    {
      crons: [{ cron: '0 8 * * *', handler: daily }],
      queues: { reminders },
      email: { 'help@clinic.example.test': vi.fn(async () => undefined) },
    },
    { handlers: { scheduled } }
  );
  const controller = (cron: string) =>
    ({ cron, scheduledTime: 0, noRetry: vi.fn() }) as unknown as ScheduledController;
  await handler.scheduled?.(controller('0 8 * * *'), env, background);
  expect(daily).toHaveBeenCalledOnce();
  await handler.scheduled?.(controller('*/5 * * * *'), env, background);
  expect(scheduled).toHaveBeenCalledOnce();
  const batch = { queue: 'reminders', messages: [] } as unknown as MessageBatch;
  await handler.queue?.(batch, env, background);
  expect(reminders).toHaveBeenCalledWith(batch, env, background);
  const setReject = vi.fn();
  const message = { to: 'billing@clinic.example.test', setReject } as unknown as ForwardableEmailMessage;
  await handler.email?.(message, env, background);
  expect(setReject).toHaveBeenCalledWith('This recipient is not configured.');
});
