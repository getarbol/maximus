/**
 * Admission of an operation call over HTTP: exact origins, the token and its scopes, the rate limit under a
 * digest of the caller, then the body, bounded by the operation's limit, and its media type, each refusal
 * answered before the operation runs and without echoing the input; and what an admitted call hands its
 * operation.
 */
import { expect, it, vi } from 'vite-plus/test';

import type { HttpMiddleware } from '../../src/http.ts';
import { createHttpHandler, defineErrors, err, maximus, ok, standardErrors, t } from '../../src/index.ts';

const ISSUER = 'https://issuer.example.test/';
const ORIGIN = 'https://records.example.test';
const ORGANIZATION = 'org_1234567890abcdef';
const empty = t.Object({}, { additionalProperties: false });
const record = t.Object({ recordId: t.String() }, { additionalProperties: false });
/** A machine client of the organization that may read and write records. */
const claims = {
  sub: 'client@clients',
  client_id: 'client',
  org_id: ORGANIZATION,
  scope: 'records:records:read records:records:write',
};
const errors = defineErrors({
  recordLocked: {
    code: 'RECORD_LOCKED',
    status: 409,
    message: 'The record is locked.',
    retryable: true,
    retryAfter: 30,
  },
  recordMissing: { code: 'RECORD_MISSING', status: 404, message: 'The record does not exist.' },
});

/** The rate limiting binding Workers provides. */
interface Env {
  LIMIT: { limit: (input: { key: string }) => Promise<{ success: boolean }> };
}

/** What every records service of this file shares. */
const configuration = {
  name: 'records',
  namespace: 'records',
  title: 'Records',
  version: '1',
  origin: ORIGIN,
  tokens: { issuer: ISSUER, audience: ORIGIN },
  errors,
  rpc: { callers: [] },
  telemetry: { enabled: false },
};
/** How `lockRecord` answers: a locked record, a missing one, or the record itself. */
const lock = vi.fn(async (_context: unknown, input: { recordId: string }) => {
  if (input.recordId === 'locked') {
    return err(errors.recordLocked.create());
  }
  return input.recordId === 'missing' ? err(errors.recordMissing.create()) : ok(input);
});
/** A records service whose one route locks a record, with the body limit given or the application's. */
function application(maxBodyBytes?: number) {
  return maximus<Env>(configuration)
    .operation(
      'lockRecord',
      {
        scope: 'records:records:write',
        title: 'Lock a record',
        description: 'Lock one record of the organization.',
        effect: 'write',
        input: record,
        output: record,
        http: { method: 'POST', path: '/v1/records/lock' },
        maxBodyBytes,
      },
      lock
    )
    .build();
}
/** A call to `lockRecord` with a token and the body and media type given. */
function post(body: BodyInit, contentType = 'application/json', origin = ORIGIN) {
  return new Request(`${origin}/v1/records/lock`, {
    method: 'POST',
    headers: { authorization: 'Bearer a.b.c', 'content-type': contentType },
    body,
  });
}
/** A binding that admits every call. */
const unlimited: Env = { LIMIT: { limit: async () => ({ success: true }) } };

it('refuses at construction an origin list that is empty or names anything but exact HTTPS origins', () => {
  for (const origins of [
    [],
    ['http://records.example.test'],
    [`${ORIGIN}/`],
    [`${ORIGIN}/v1`],
    ['https://reader@records.example.test'],
    [ORIGIN, 'https://records.example.test:8443/'],
  ]) {
    expect(() => createHttpHandler(application(), { origins }), origins.join(' ')).toThrow(
      'HTTP origins must be exact HTTPS origins.'
    );
  }
});

it('answers a request to another origin NOT_FOUND before any hook or token', async () => {
  const before = vi.fn(async () => null);
  const verify = vi.fn(async () => claims);
  const handle = createHttpHandler(application(), {
    origins: [ORIGIN, 'https://records.example.org'],
    before,
    verify,
  });
  const foreign = await handle(
    post('{"recordId":"r1"}', 'application/json', 'https://evil.example.test'),
    unlimited
  );
  expect(foreign.status).toBe(404);
  expect(before).not.toHaveBeenCalled();
  expect(verify).not.toHaveBeenCalled();
  const listed = await handle(
    post('{"recordId":"r1"}', 'application/json', 'https://records.example.org'),
    unlimited
  );
  expect(listed.status).toBe(200);
});

it('refuses at construction a middleware entry that is not a function', () => {
  const middleware = [async (_request, _env, _context, next) => next(), 'audit'] as HttpMiddleware<Env>[];
  expect(() => createHttpHandler(application(), { middleware })).toThrow(
    'Every HTTP middleware entry must be a function.'
  );
});

it('admits an operation that requires all of its scopes only for a token that holds every one', async () => {
  const audit = vi.fn(async () => ok({}));
  const app = maximus<Env>(configuration)
    .operation(
      'auditRecords',
      {
        scope: ['records:records:read', 'records:audit:read'],
        scopeMatch: 'all',
        title: 'Audit records',
        description: 'Read the audit trail of the organization records.',
        effect: 'read',
        input: empty,
        output: empty,
        http: { method: 'GET', path: '/v1/records/audit' },
      },
      audit
    )
    .build();
  const both = 'records:records:read records:audit:read';
  // A person whose token names no client carries no authority into execution, so admission alone checks.
  const person = { sub: 'person', org_id: ORGANIZATION };
  for (const [granted, status] of [
    [{ ...claims, scope: 'records:records:read' }, 403],
    [{ ...claims, scope: both }, 200],
    [{ ...person, scope: both, permissions: ['records:records:read'] }, 403],
    [{ ...person, scope: both, permissions: both.split(' ') }, 200],
  ] as const) {
    const response = await createHttpHandler(app, { verify: async () => granted })(
      new Request(`${ORIGIN}/v1/records/audit`, { headers: { authorization: 'Bearer a.b.c' } }),
      unlimited
    );
    expect(response.status, JSON.stringify(granted)).toBe(status);
  }
  expect(audit).toHaveBeenCalledTimes(2);
});

it('rate limits each call under a digest of the organization and actor, with the catalog Retry-After', async () => {
  lock.mockClear();
  const limit = vi.fn(async () => ({ success: false }));
  const app = { ...application(), rateLimit: { binding: 'LIMIT' as const } };
  const response = await createHttpHandler(app, { verify: async () => claims })(post('{"recordId":"r1"}'), {
    LIMIT: { limit },
  });
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('60');
  expect(await response.json()).toMatchObject({ error: { code: 'RATE_LIMITED', retryable: true } });
  // The key names who calls without carrying either identifier.
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${ORGANIZATION}:client@clients`))
  );
  const key = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  expect(limit).toHaveBeenCalledExactlyOnceWith({ key });
  expect(lock).not.toHaveBeenCalled();
});

it('answers INTERNAL_ERROR, before the operation runs, when the rate limit binding is missing or fails', async () => {
  lock.mockClear();
  const handle = createHttpHandler(
    { ...application(), rateLimit: { binding: 'LIMIT' as const } },
    { verify: async () => claims }
  );
  const failing: Env = {
    LIMIT: {
      limit: async () => {
        throw new Error('rate limiter at 10.0.0.7 unavailable');
      },
    },
  };
  // A deployment without the binding, and a binding that fails.
  for (const env of [{} as Env, failing]) {
    const response = await handle(post('{"recordId":"r1"}'), env);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(text).not.toContain('10.0.0.7');
  }
  expect(lock).not.toHaveBeenCalled();
});

it('refuses a call by its token, its scope, its rate limit or its media type without reading its body, however large', async () => {
  lock.mockClear();
  /** A call to `lockRecord` that sends a 1 MiB record id, with the headers given. */
  const large = (headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}/v1/records/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ recordId: 'r'.repeat(1_048_576) }),
    });
  const token = { authorization: 'Bearer a.b.c' };
  const writer = createHttpHandler(application(), { verify: async () => claims });
  const reader = createHttpHandler(application(), {
    verify: async () => ({ ...claims, scope: 'records:records:read' }),
  });
  const limited = createHttpHandler(
    { ...application(), rateLimit: { binding: 'LIMIT' as const } },
    { verify: async () => claims }
  );
  const exhausted: Env = { LIMIT: { limit: async () => ({ success: false }) } };
  for (const [status, handle, request, env] of [
    [401, writer, large(), unlimited],
    [403, reader, large(token), unlimited],
    [429, limited, large(token), exhausted],
    [415, writer, large({ ...token, 'content-type': 'text/plain' }), unlimited],
  ] as const) {
    expect((await handle(request, env)).status).toBe(status);
    expect(request.bodyUsed, String(status)).toBe(false);
  }
  // Admitted, the same body is read and refused as too large.
  expect((await writer(large(token), unlimited)).status).toBe(413);
  expect(lock).not.toHaveBeenCalled();
});

it('answers a domain failure with its status, and with Retry-After only when its definition declares one', async () => {
  const handle = createHttpHandler(application(), { verify: async () => claims });
  const locked = await handle(post('{"recordId":"locked"}'), unlimited);
  expect(locked.status).toBe(409);
  expect(locked.headers.get('retry-after')).toBe('30');
  expect(await locked.json()).toMatchObject({ success: false, error: errors.recordLocked.create() });
  const missing = await handle(post('{"recordId":"missing"}'), unlimited);
  expect(missing.status).toBe(404);
  expect(missing.headers.has('retry-after')).toBe(false);
});

it('refuses a body that is not UTF-8, not JSON or of another media type before the operation runs', async () => {
  lock.mockClear();
  const handle = createHttpHandler(application(), { verify: async () => claims });
  const invalid = await handle(post(new Uint8Array([0x7b, 0xff, 0x7d])), unlimited);
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  const malformed = await handle(post('{"recordId":"private-record-name"'), unlimited);
  expect(malformed.status).toBe(400);
  expect(await malformed.text()).not.toContain('private-record-name');
  const text = await handle(post('{"recordId":"r1"}', 'text/plain'), unlimited);
  expect(text.status).toBe(415);
  expect(await text.json()).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } });
  expect(lock).not.toHaveBeenCalled();
  // The media type is read without its parameters and its case.
  const parameters = await handle(post('{"recordId":"r1"}', 'Application/JSON; charset=utf-8'), unlimited);
  expect(await parameters.json()).toMatchObject({ success: true, data: { recordId: 'r1' } });
});

it("holds a JSON body to the operation's own limit, raised above or lowered below the application's", async () => {
  lock.mockClear();
  /** A call to `lockRecord` whose record id takes the bytes given. */
  const sized = (bytes: number) => post(JSON.stringify({ recordId: 'r'.repeat(bytes) }));
  // 40 KiB is beyond the application's 32 KiB, and 2 KiB within it.
  for (const [maxBodyBytes, bytes, status] of [
    [undefined, 40 * 1024, 413],
    [64 * 1024, 40 * 1024, 200],
    [1024, 2 * 1024, 413],
  ] as const) {
    const handle = createHttpHandler(application(maxBodyBytes), { verify: async () => claims });
    expect((await handle(sized(bytes), unlimited)).status, `${maxBodyBytes} ${bytes}`).toBe(status);
  }
  expect(lock).toHaveBeenCalledOnce();
});

it("hands the operation the verified client but never the token under the application's own bearer scheme", async () => {
  const app = maximus<Record<string, never>>({
    ...configuration,
    tokens: {
      audience: ORIGIN,
      scheme: { type: 'bearer', description: 'A visitor session.' },
      resolve: async (token) =>
        token === 'visitor-session'
          ? {
              actorId: 'visitor-1',
              actorKind: 'user',
              organizationId: ORGANIZATION,
              scopes: ['records:records:read'],
              client: { id: 'web', class: 'human' },
            }
          : err(standardErrors.unauthorized.create()),
    },
  })
    .operation(
      'whoAmI',
      {
        scope: 'records:records:read',
        title: 'Who am I',
        description: 'Answer what the call was admitted with.',
        effect: 'read',
        input: empty,
        output: t.Object(
          { client: t.String(), token: t.Union([t.String(), t.Null()]) },
          { additionalProperties: false }
        ),
        http: { method: 'GET', path: '/v1/me' },
      },
      async ({ authority }) => ok({ client: authority?.client.id ?? '', token: authority?.token ?? null })
    )
    .build();
  const handle = createHttpHandler(app);
  const call = (authorization: string) =>
    handle(new Request(`${ORIGIN}/v1/me`, { headers: { authorization } }), {});
  expect(await (await call('Bearer visitor-session')).json()).toMatchObject({
    data: { client: 'web', token: null },
  });
  const refused = await call('Bearer stolen-session');
  expect(refused.status).toBe(401);
  expect(refused.headers.get('www-authenticate')).toBe('Bearer');
});

it("lets a transport run only the application's own operations", async () => {
  lock.mockClear();
  const app = application();
  const own = app.operations.lockRecord;
  const handle = createHttpHandler(app, {
    verify: async () => claims,
    transports: [
      {
        path: '/tools',
        scope: () => 'records:records:write',
        handle: async ({ invoke }) =>
          Response.json({
            unknown: await invoke('unlockRecord', own, { recordId: 'r1' }),
            copied: await invoke('lockRecord', { ...own }, { recordId: 'r1' }),
            declared: await invoke('lockRecord', own, { recordId: 'r1' }),
          }),
      },
    ],
  });
  const response = await handle(
    new Request(`${ORIGIN}/tools`, { method: 'POST', headers: { authorization: 'Bearer a.b.c' } }),
    unlimited
  );
  expect(await response.json()).toStrictEqual({
    unknown: { ok: false, error: standardErrors.notFound.create() },
    copied: { ok: false, error: standardErrors.notFound.create() },
    declared: { ok: true, value: { recordId: 'r1' } },
  });
  expect(lock).toHaveBeenCalledOnce();
});
