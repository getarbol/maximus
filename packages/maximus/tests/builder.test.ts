/**
 * The fluent builder: derived context, resource modules, middleware order and single `next`, the Result
 * shape at the output boundary, and what `.build()` refuses.
 */
import { expect, it, vi } from 'vite-plus/test';

import { maximus, t, ok, err, standardErrors, defineErrors, createHttpHandler } from '../src/index.ts';
import type { TSchema } from '../src/index.ts';
import { inputSchema, normalizeSchema, refineSchema, stripObject } from '../src/input-schemas.ts';

const claims = {
  sub: 'client@clients',
  client_id: 'client',
  org_id: 'org_1234567890abcdef',
  scope: 'test:records:read',
};
const configuration = {
  name: 'test',
  namespace: 'test',
  title: 'Test',
  version: '2',
  origin: 'https://example.test',
  tokens: { issuer: 'https://issuer.example.test/', audience: 'test' },
  errors: defineErrors({}),
  rpc: { callers: [] },
};
const schema = t.Object({ value: t.String() }, { additionalProperties: false });
const route = {
  input: schema,
  output: schema,
  title: 'Read',
  description: 'Read a record.',
  scope: 'test:records:read',
  effect: 'read' as const,
  http: { method: 'POST' as const, path: '/v1/records/read' },
};
const request = (token = 'a.b.c') =>
  new Request('https://example.test/v1/records/read', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{"value":"hello"}',
  });
it('infers derived context, isolates resource composition and runs middleware around authorized execution', async () => {
  const calls: string[] = [];
  const base = maximus<{ prefix: string }>(configuration)
    .derive(async ({ env }) => ok({ label: env.prefix }))
    .use(async (context, proceed) => {
      calls.push(context.label);
      const result = await proceed();
      calls.push('after');
      return result;
    });
  const resource = base.operation('readRecord', route, async (context, input) => {
    calls.push('handler');
    return ok({ value: context.label + input.value });
  });
  const app = base.mount(resource).build();
  expect(Object.keys(base.build().operations)).toEqual([]);
  const handle = createHttpHandler(app, { verify: async () => claims });
  expect(await (await handle(request(), { prefix: 'prefix:' })).json()).toMatchObject({
    data: { value: 'prefix:hello' },
  });
  expect(calls).toEqual(['prefix:', 'handler', 'after']);
  calls.length = 0;
  expect((await handle(request('invalid'), { prefix: 'other' })).status).toBe(401);
  expect(calls).toEqual([]);
  // @ts-expect-error Mounting an operation twice is refused by the type as well as at run time.
  expect(() => resource.mount(resource)).toThrow('Duplicate');
});
it('stops at the first derivation that fails, and derives only before any operation', async () => {
  const later = vi.fn(async () => ok({ audited: true }));
  const app = maximus<Record<string, never>>(configuration)
    .derive(async () => err(standardErrors.forbidden.create()))
    .derive(later)
    .operation('readRecord', route, async (_context, input) => ok(input))
    .build();
  expect((await createHttpHandler(app, { verify: async () => claims })(request(), {})).status).toBe(403);
  expect(later).not.toHaveBeenCalled();
  const declared = maximus<Record<string, never>>(configuration).operation(
    'readRecord',
    route,
    async (_c, input) => ok(input)
  );
  expect(() => declared.derive(async () => ok({}))).toThrow('Derive context before declaring operations.');
});
it('rejects middleware double-proceed and validates middleware output before returning it', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const base = maximus<Record<string, never>>(configuration);
    const twice = base
      .use(async (_context, proceed) => {
        await proceed();
        return proceed();
      })
      .operation('readRecord', route, async (_context, input) => ok(input))
      .build();
    expect((await createHttpHandler(twice, { verify: async () => claims })(request(), {})).status).toBe(500);
    const invalid = base
      .use(async () => ok({ secret: 'private' }))
      .operation('readRecord', route, async (_context, input) => ok(input))
      .build();
    const response = await createHttpHandler(invalid, { verify: async () => claims })(request(), {});
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('private');
  } finally {
    log.mockRestore();
  }
});
it('mounts scoped preparation and middleware without running it for management operations', async () => {
  const calls: string[] = [];
  const root = maximus<{ credential: string | null }>(configuration).derive(async () => {
    calls.push('base');
    return ok({ label: 'root' });
  });
  const connected = root
    .derive(async ({ env }) => {
      calls.push('credential');
      return env.credential ? ok({ credential: env.credential }) : err(standardErrors.forbidden.create());
    })
    .use(async ({ credential }, proceed) => {
      calls.push(`before:${credential}`);
      const result = await proceed();
      calls.push('after');
      return result;
    });
  const business = connected.operation('readRecord', route, async ({ credential }, input) => {
    calls.push('business');
    return ok({ value: credential + input.value });
  });
  const management = root.operation(
    'setup',
    {
      ...route,
      http: { method: 'POST', path: '/v1/connections/setup' },
    },
    async ({ label }, input) => {
      calls.push('setup');
      return ok({ value: label + input.value });
    }
  );
  const app = root.mount(business).mount(management).build();
  const handle = createHttpHandler(app, { verify: async () => claims });
  expect(
    (await handle(new Request('https://example.test/v1/connections/setup', request()), { credential: null }))
      .status
  ).toBe(200);
  expect(calls.splice(0)).toEqual(['base', 'setup']);
  expect(await (await handle(request(), { credential: 'secret:' })).json()).toMatchObject({
    data: { value: 'secret:hello' },
  });
  expect(calls.splice(0)).toEqual(['base', 'credential', 'before:secret:', 'business', 'after']);
  expect((await handle(request(), { credential: null })).status).toBe(403);
  expect(calls.splice(0)).toEqual(['base', 'credential']);
  const invalid = new Request(request(), { method: 'POST', body: '{"wrong":true}' });
  expect((await handle(invalid, { credential: 'secret:' })).status).toBe(400);
  expect(calls).toEqual([]);
  expect(() => root.mount(maximus<{ credential: string | null }>(configuration))).toThrow('same application');
});
it('captures middleware in declaration order without changing previously declared operations', async () => {
  const events: string[] = [];
  const base = maximus<Record<string, never>>(configuration);
  const early = base.operation('readRecord', route, async (_context, input) => ok(input));
  const late = early.use(async (_context, proceed) => {
    events.push('later');
    return proceed();
  });
  const handle = createHttpHandler(late.build(), { verify: async () => claims });
  expect((await handle(request(), {})).status).toBe(200);
  expect(events).toEqual([]);
});

it('rejects extra Result envelope fields at the shared output boundary', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const app = maximus<Record<string, never>>(configuration)
      .operation('readRecord', route, async (_context, input) => ({
        ...ok(input),
        privateValue: 'ENVELOPE_SENTINEL',
      }))
      .build();
    const response = await createHttpHandler(app, { verify: async () => claims })(request(), {});
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('ENVELOPE_SENTINEL');
  } finally {
    log.mockRestore();
  }
});

it('refuses at construction an OAuth application that could never verify a token', () => {
  const build = (tokens: Record<string, unknown>) => () =>
    maximus<Record<string, never>>({ ...configuration, tokens: tokens as never })
      .operation('readRecord', route, async (_context, input) => ok(input))
      .build();
  expect(build({ audience: 'test' })).toThrow('tokens.issuer is required');
  expect(build({ audience: 'test', issuer: 'http://issuer.example.test/' })).toThrow('absolute HTTPS URLs');
  expect(build({ audience: 'test', issuer: 'issuer.example.test' })).toThrow('absolute HTTPS URLs');
  expect(
    build({
      audience: 'test',
      issuer: 'https://issuer.example.test/',
      jwksUri: 'http://keys.example.test/jwks.json',
    })
  ).toThrow('absolute HTTPS URLs');
  for (const endpoint of ['authorizationEndpoint', 'tokenEndpoint']) {
    expect(
      build({
        audience: 'test',
        issuer: 'https://issuer.example.test/',
        [endpoint]: 'http://issuer.example.test/x',
      })
    ).toThrow('absolute HTTPS URLs');
  }
  expect(
    build({
      audience: 'test',
      issuer: 'https://issuer.example.test/',
      jwksUri: '/keys.json',
      authorizationEndpoint: 'oauth2/authorize',
      tokenEndpoint: 'https://issuer.example.test/oauth2/token',
    })
  ).not.toThrow();
  // An application that issues its own bearer tokens names no authorization server.
  expect(
    build({
      audience: 'test',
      scheme: { type: 'bearer', description: 'Session token.' },
      resolve: async () => ({
        actorId: 'visitor',
        actorKind: 'user',
        client: { class: 'human', id: 'widget' },
        organizationId: 'org_1234567890abcdef',
        scopes: ['test:records:read'],
      }),
    })
  ).not.toThrow();
});

it('refuses an operation field no operation has, which would otherwise do nothing', () => {
  const define = (definition: object) => () =>
    maximus<Record<string, never>>(configuration)
      .operation('readRecord', definition as typeof route, async (_context, input) => ok(input))
      .build();
  expect(define(route)).not.toThrow();
  // A retired field, such as an `api` name or a `publish` choice, and a misspelled one.
  expect(define({ ...route, api: { resource: 'records', verb: 'get' } })).toThrow(
    'Operation "readRecord": "api" is not an operation field.'
  );
  expect(define({ ...route, publish: { rest: true, mcp: false } })).toThrow(
    '"publish" is not an operation field'
  );
  expect(define({ ...route, htpp: route.http })).toThrow('"htpp" is not an operation field');
});

it('refuses an application output limit outside the body ceiling', () => {
  for (const maxOutputBytes of [0, 1.5, 17 * 1024 * 1024]) {
    expect(() => maximus<Record<string, never>>({ ...configuration, maxOutputBytes }).build()).toThrow(
      'output limit'
    );
  }
  expect(() =>
    maximus<Record<string, never>>({ ...configuration, maxOutputBytes: 1024 }).build()
  ).not.toThrow();
});

it('refuses at construction an input whose codecs only inputSchema() would run', () => {
  const trimmed = normalizeSchema(t.String({ minLength: 1 }), (value) => value.trim());
  const define = (input: TSchema) => () =>
    maximus<Record<string, never>>(configuration)
      .operation('readRecord', { ...route, input }, async () => ok({ value: 'read' }))
      .build();
  const strict = (properties: Record<string, TSchema>) =>
    t.Object(properties, { additionalProperties: false });
  expect(define(strict({ value: trimmed }))).toThrow('inputSchema()');
  expect(define(strict({ value: refineSchema(t.String(), (value) => value.length > 0) }))).toThrow(
    'inputSchema()'
  );
  expect(define(stripObject({ value: t.String() }))).toThrow('inputSchema()');
  expect(define(strict({ list: t.Array(strict({ value: trimmed })) }))).toThrow('inputSchema()');
  expect(define(inputSchema(strict({ value: trimmed })))).not.toThrow();
  expect(define(inputSchema(stripObject({ value: t.String() })))).not.toThrow();
});

it('refuses configured OAuth resources without the metadata a 401 challenge points at', () => {
  const resources = {
    '/.well-known/oauth-protected-resource/api': {
      audience: 'https://example.test/api',
      authorizationServers: ['https://issuer.example.test/'],
      scopes: ['test:records:read'],
    },
  };
  const build = (tokens: Record<string, unknown>) => () =>
    maximus<Record<string, never>>({
      ...configuration,
      tokens: { ...configuration.tokens, ...tokens } as never,
    }).build();
  expect(build({ resources })).toThrow('tokens.resourceMetadataUrl');
  expect(
    build({ resources, resourceMetadataUrl: 'https://example.test/.well-known/oauth-protected-resource/api' })
  ).not.toThrow();
  expect(build({ resources: {}, resourceMetadataUrl: null })).not.toThrow();
});
