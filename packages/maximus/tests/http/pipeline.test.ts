/**
 * The request pipeline around native dispatch: ordered middleware over a bodyless copy of the request and a
 * continuation that runs once, `aroundOperation` scoping the env of a matched operation, a request id of its
 * own on every answer, background work of plain routes, upgrades passed through, unexpected errors answered
 * as INTERNAL_ERROR without their message, and each refused admission observed.
 */
import { expect, it, vi } from 'vite-plus/test';

import type { HttpMiddleware, HttpOptions } from '../../src/http.ts';
import { createHttpHandler, defineErrors, maximus, ok, t } from '../../src/index.ts';
import type {
  AdmissionObservation,
  BackgroundContext,
  TelemetryConfig,
  TokenPrincipal,
} from '../../src/index.ts';

const ISSUER = 'https://issuer.example.test/';
const ORIGIN = 'https://records.example.test';
const ORGANIZATION = 'org_1234567890abcdef';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const record = t.Object({ recordId: t.String() }, { additionalProperties: false });
/** A machine client of the organization that may write records. */
const claims = {
  sub: 'client@clients',
  client_id: 'client',
  org_id: ORGANIZATION,
  scope: 'records:records:write',
};

/** The database a request is scoped to, and the rate limiting binding Workers provides. */
interface Env {
  DATABASE: string;
  LIMIT?: { limit: (input: { key: string }) => Promise<{ success: boolean }> };
}
const env: Env = { DATABASE: 'primary' };

/** What `lockRecord` answers: the record and the database it ran against. */
const lock = vi.fn(async ({ env: scoped }: { env: Env }, input: { recordId: string }) =>
  ok({ recordId: input.recordId, database: scoped.DATABASE })
);
/** A records service whose one route locks a record, with the telemetry given (off by default). */
function application(telemetry: TelemetryConfig<Env> = { enabled: false }) {
  return maximus<Env>({
    name: 'records',
    namespace: 'records',
    title: 'Records',
    version: '1',
    origin: ORIGIN,
    tokens: { issuer: ISSUER, audience: ORIGIN },
    errors: defineErrors({}),
    rpc: { callers: [] },
    telemetry,
  })
    .operation(
      'lockRecord',
      {
        scope: 'records:records:write',
        title: 'Lock a record',
        description: 'Lock one record of the organization.',
        effect: 'write',
        input: record,
        output: t.Object({ recordId: t.String(), database: t.String() }, { additionalProperties: false }),
        http: { method: 'POST', path: '/v1/records/lock' },
      },
      lock
    )
    .build();
}
/** A call to `lockRecord` with a token. */
function post() {
  return new Request(`${ORIGIN}/v1/records/lock`, {
    method: 'POST',
    headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json' },
    body: '{"recordId":"r1"}',
  });
}
/** The handler with the token verified as `claims` and the options given. */
function handler(options: HttpOptions<Env>, app = application()) {
  return createHttpHandler(app, { verify: async () => claims, ...options });
}

it('wraps native dispatch in ordered middleware that sees a bodyless copy of the request', async () => {
  const order: string[] = [];
  const seen: unknown[] = [];
  const outer: HttpMiddleware<Env> = async (_request, _env, _context, proceed) => {
    order.push('outer');
    const response = await proceed();
    order.push('outer:after');
    const headers = new Headers(response.headers);
    headers.set('x-audited', 'yes');
    return new Response(response.body, { status: response.status, headers });
  };
  const inner: HttpMiddleware<Env> = async (request, _env, context, proceed) => {
    order.push('inner');
    seen.push({
      body: request.body,
      authorization: request.headers.get('authorization'),
      id: context.requestId,
    });
    // Changing the copy changes nothing native admission reads.
    request.headers.set('authorization', 'Bearer forged.forged.forged');
    return proceed();
  };
  const verify = vi.fn(async () => claims);
  const response = await handler({ verify, middleware: [outer, inner] })(post(), env);
  expect(await response.json()).toMatchObject({
    success: true,
    data: { recordId: 'r1', database: 'primary' },
  });
  expect(response.headers.get('x-audited')).toBe('yes');
  expect(order).toEqual(['outer', 'inner', 'outer:after']);
  expect(seen).toEqual([
    { body: null, authorization: 'Bearer a.b.c', id: response.headers.get('x-request-id') },
  ]);
  expect(verify).toHaveBeenCalledExactlyOnceWith('a.b.c');
});

it('answers with a request id of its own, never one the caller sends or a plain route sets', async () => {
  lock.mockClear();
  const seen: string[] = [];
  const handle = handler({
    routes: {
      '/hooks/payments': async (_request, _env, context) => {
        seen.push(context.requestId);
        return new Response(null, { status: 204, headers: { 'x-request-id': 'route-chosen' } });
      },
    },
  });
  const called = post();
  called.headers.set('x-request-id', 'caller-chosen');
  const answered = await handle(called, env);
  const id = answered.headers.get('x-request-id');
  expect(id).toMatch(UUID);
  expect(await answered.json()).toMatchObject({ metadata: { requestId: id } });
  expect(lock.mock.calls[0]?.[0]).toMatchObject({ principal: { requestId: id } });
  const routed = await handle(
    new Request(`${ORIGIN}/hooks/payments`, { method: 'POST', headers: { 'x-request-id': 'caller-chosen' } }),
    env
  );
  expect(routed.headers.get('x-request-id')).toMatch(UUID);
  expect(seen).toEqual([routed.headers.get('x-request-id')]);
});

it('lets middleware answer without dispatching, and refuses a continuation run twice or after its wrapper settled', async () => {
  lock.mockClear();
  const verify = vi.fn(async () => claims);
  const maintenance = handler({
    verify,
    middleware: [async () => new Response('maintenance', { status: 503 })],
  });
  const answered = await maintenance(post(), env);
  expect(answered.status).toBe(503);
  expect(await answered.text()).toBe('maintenance');
  expect(verify).not.toHaveBeenCalled();

  const twice = handler({
    middleware: [
      async (_request, _env, _context, proceed) => {
        await proceed();
        return proceed();
      },
    ],
  });
  const repeated = await twice(post(), env);
  expect(repeated.status).toBe(500);
  expect(await repeated.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  expect(lock).toHaveBeenCalledOnce();

  let kept: (() => Promise<Response>) | undefined;
  const settled = handler({
    middleware: [
      async (_request, _env, _context, proceed) => {
        kept = proceed;
        return new Response('early');
      },
    ],
  });
  expect(await (await settled(post(), env)).text()).toBe('early');
  expect(() => kept?.()).toThrow(
    'An HTTP middleware continuation may run only once before its wrapper settles.'
  );
  expect(lock).toHaveBeenCalledOnce();
});

it('scopes the env of a matched operation, its token admission included, and of nothing else', async () => {
  const resolved: unknown[] = [];
  const app = application();
  const scoped = {
    ...app,
    tokens: {
      ...app.tokens,
      resolve: async (_token: string, context?: { env: Env }): Promise<TokenPrincipal> => {
        resolved.push(context?.env.DATABASE);
        return {
          actorId: 'client@clients',
          actorKind: 'service',
          organizationId: ORGANIZATION,
          scopes: ['records:records:write', 'records:tools:use'],
        };
      },
    },
  };
  const around = vi.fn<NonNullable<HttpOptions<Env>['aroundOperation']>>(
    async (_request, outer, operation, run) => run({ DATABASE: `${outer.DATABASE}:${operation.effect}` })
  );
  const handle = createHttpHandler(scoped, {
    aroundOperation: around,
    routes: { '/hooks/payments': async () => new Response(null, { status: 204 }) },
    transports: [
      { path: '/tools', scope: () => 'records:tools:use', handle: async () => new Response('tools') },
    ],
  });
  expect(await (await handle(post(), env)).json()).toMatchObject({
    data: { recordId: 'r1', database: 'primary:write' },
  });
  expect(around).toHaveBeenCalledOnce();
  expect(around.mock.calls[0]?.[2]).toStrictEqual({ name: 'lockRecord', effect: 'write' });
  expect(resolved).toEqual(['primary:write']);
  // Discovery, plain routes and transports bypass it.
  for (const request of [
    new Request(`${ORIGIN}/health`),
    new Request(`${ORIGIN}/openapi.json`),
    new Request(`${ORIGIN}/hooks/payments`, { method: 'POST' }),
    new Request(`${ORIGIN}/tools`, { method: 'POST', headers: { authorization: 'Bearer a.b.c' } }),
  ]) {
    expect((await handle(request, env)).ok, request.url).toBe(true);
  }
  expect(around).toHaveBeenCalledOnce();
  expect(resolved).toEqual(['primary:write', 'primary']);
});

it('fails closed when aroundOperation runs the operation twice', async () => {
  lock.mockClear();
  const handle = handler({
    aroundOperation: async (_request, outer, _operation, run) => {
      await run(outer);
      return run(outer);
    },
  });
  const response = await handle(post(), env);
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  expect(lock).toHaveBeenCalledOnce();
});

it('answers an exception as INTERNAL_ERROR, logs only its safe description, and observes only a pipeline exception as a refusal', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const admission = vi.fn(async (_event: AdmissionObservation) => undefined);
    const tasks: Promise<unknown>[] = [];
    const background: BackgroundContext = { waitUntil: (task) => tasks.push(task) };
    const handle = handler(
      {
        routes: {
          '/hooks/payments': async () => {
            throw new Error('ledger password rejected');
          },
        },
        middleware: [
          async (request, _env, _context, proceed) => {
            if (new URL(request.url).pathname === '/v1/records/lock') {
              throw new Error('audit store password rejected');
            }
            return proceed();
          },
        ],
      },
      application({ observers: [{ admission }] })
    );
    const route = await handle(new Request(`${ORIGIN}/hooks/payments`, { method: 'POST' }), env, background);
    const pipeline = await handle(post(), env, background);
    await Promise.all(tasks);
    for (const response of [route, pipeline]) {
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).not.toContain('password');
      expect(JSON.parse(text)).toMatchObject({
        error: { code: 'INTERNAL_ERROR' },
        metadata: { requestId: response.headers.get('x-request-id') },
      });
    }
    expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)))).toMatchObject([
      {
        event: 'maximus.unexpected',
        surface: 'route',
        requestId: route.headers.get('x-request-id'),
        name: 'Error',
      },
      {
        event: 'maximus.unexpected',
        surface: 'http',
        requestId: pipeline.headers.get('x-request-id'),
        name: 'Error',
      },
    ]);
    expect(JSON.stringify([errors.mock.calls, warnings.mock.calls])).not.toContain('password');
    // A plain route owns its failure; only the native pipeline's is an admission refusal.
    expect(admission).toHaveBeenCalledOnce();
    expect(admission.mock.calls[0]?.[0]).toMatchObject({
      operation: null,
      principal: null,
      surface: 'http',
      requestId: pipeline.headers.get('x-request-id'),
      errorCode: 'INTERNAL_ERROR',
    });
  } finally {
    errors.mockRestore();
    warnings.mockRestore();
  }
});

it('observes each refused admission, with the principal only once its token is admitted, and no execution', async () => {
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const admission = vi.fn(async (_event: AdmissionObservation) => undefined);
    const execution = vi.fn(async () => undefined);
    const tasks: Promise<unknown>[] = [];
    const background: BackgroundContext = { waitUntil: (task) => tasks.push(task) };
    const app = {
      ...application({ observers: [{ admission, execution }] }),
      rateLimit: { binding: 'LIMIT' as const },
    };
    const exhausted: Env = { ...env, LIMIT: { limit: async () => ({ success: false }) } };
    const writer = handler({}, app);
    const reader = handler({ verify: async () => ({ ...claims, scope: 'records:records:read' }) }, app);
    const tokenless = new Request(`${ORIGIN}/v1/records/lock`, { method: 'POST' });
    const unknown = new Request(`${ORIGIN}/v1/records/unknown`, {
      method: 'POST',
      headers: { authorization: 'Bearer a.b.c' },
    });
    const responses = [
      await writer(tokenless, exhausted, background),
      await reader(post(), exhausted, background),
      await writer(unknown, exhausted, background),
      await writer(post(), exhausted, background),
    ];
    await Promise.all(tasks);
    expect(responses.map((response) => response.status)).toEqual([401, 403, 404, 429]);
    const [unauthorized, forbidden, missing, limited] = responses.map((response) =>
      response.headers.get('x-request-id')
    );
    expect(admission.mock.calls.map(([event]) => event)).toMatchObject([
      { operation: 'lockRecord', principal: null, requestId: unauthorized, errorCode: 'UNAUTHORIZED' },
      { operation: 'lockRecord', principal: null, requestId: forbidden, errorCode: 'FORBIDDEN' },
      { operation: null, principal: null, requestId: missing, errorCode: 'NOT_FOUND' },
      { operation: 'lockRecord', requestId: limited, errorCode: 'RATE_LIMITED' },
    ]);
    // The rate limit refuses a verified caller, observed as the principal an operation would receive.
    expect(admission.mock.calls[3]?.[0].principal).toStrictEqual({
      actorId: 'client@clients',
      actorKind: 'service',
      organizationId: ORGANIZATION,
      requestId: limited,
    });
    expect(execution).not.toHaveBeenCalled();
  } finally {
    warnings.mockRestore();
  }
});

it('passes a protocol upgrade through untouched, since rebuilding it would drop its socket', async () => {
  // Workers answers a WebSocket upgrade with status 101, which Node's Response cannot be constructed with.
  const upgrade = new Response(null, { status: 200 });
  Object.defineProperty(upgrade, 'status', { value: 101 });
  const handle = handler({ routes: { '/socket': async () => upgrade } });
  const response = await handle(new Request(`${ORIGIN}/socket`, { headers: { upgrade: 'websocket' } }), env);
  expect(response).toBe(upgrade);
  expect(response.headers.has('x-request-id')).toBe(false);
});

it("hands a plain route's background work to the runtime, and reports one that fails without a runtime", async () => {
  const delivered = Promise.resolve('delivered');
  const tasks: Promise<unknown>[] = [];
  const queued = handler({
    routes: {
      '/hooks/payments': async (_request, _env, context) => {
        context.waitUntil(delivered);
        return new Response(null, { status: 202 });
      },
    },
  });
  expect(
    (await queued(new Request(`${ORIGIN}/hooks/payments`), env, { waitUntil: (task) => tasks.push(task) }))
      .status
  ).toBe(202);
  expect(tasks).toEqual([delivered]);

  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const failing = handler(
      {
        routes: {
          '/hooks/payments': async (_request, _env, context) => {
            context.waitUntil(Promise.reject(new Error('webhook secret mismatch')));
            return new Response(null, { status: 202 });
          },
        },
      },
      application({})
    );
    const response = await failing(new Request(`${ORIGIN}/hooks/payments`), env);
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledOnce());
    expect(JSON.parse(String(errors.mock.calls[0]?.[0]))).toMatchObject({
      event: 'maximus.unexpected',
      surface: 'route',
      requestId: response.headers.get('x-request-id'),
    });
    expect(JSON.stringify(errors.mock.calls)).not.toContain('secret');
  } finally {
    errors.mockRestore();
  }
});
