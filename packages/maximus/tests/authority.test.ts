/**
 * Verified invocation authority: the client, surface and scopes a transport verified reach preparation,
 * middleware and the handler unchanged, and conditional operations fail closed without them.
 */
import { expect, it, vi } from 'vite-plus/test';

import { executeOperation } from '../src/execution.ts';
import {
  maximus,
  t,
  ok,
  err,
  standardErrors,
  defineErrors,
  createHttpHandler,
  PrincipalSchema,
  parseInput,
  projectToken,
} from '../src/index.ts';
import type { InvocationAuthority } from '../src/manifest.ts';

const organizationId = 'org_1234567890abcdef';
const principal = {
  actorId: 'person',
  actorKind: 'user' as const,
  organizationId,
  requestId: '00000000-0000-4000-8000-000000000001',
};
const configuration = {
  name: 'test',
  namespace: 'test',
  title: 'Test',
  version: '2',
  origin: 'https://example.test',
  tokens: { issuer: 'https://issuer.example.test/', audience: 'test' },
  errors: defineErrors({}),
  rpc: { callers: ['internal'] },
};
const input = t.Object({ managed: t.Boolean() }, { additionalProperties: false });
const definition = {
  scope: 'test:records:read',
  conditionalScopes: ['test:records:manage'],
  title: 'Read',
  description: 'Read',
  effect: 'read' as const,
  input,
  output: input,
  http: { method: 'POST' as const, path: '/v1/records/read' },
};
const authority: InvocationAuthority = {
  surface: 'http',
  scopes: ['test:records:read'],
  client: { id: 'first-party', class: 'human' },
};

it('preserves verified originating client and human scope/permission intersection', () => {
  const result = projectToken({
    sub: 'person',
    org_id: organizationId,
    azp: 'first-party',
    client_id: 'first-party',
    scope: 'test:records:read test:records:manage',
    permissions: ['test:records:read', 'test:records:delete'],
  });
  expect(result).toMatchObject({
    ok: true,
    value: { client: { id: 'first-party', class: 'human' }, scopes: ['test:records:read'] },
  });
  expect(
    projectToken({
      sub: 'machine@clients',
      org_id: organizationId,
      client_id: 'other',
      scope: 'test:records:read',
    }).ok
  ).toBe(false);
  expect(parseInput(PrincipalSchema, { ...principal, client: authority.client }).ok).toBe(false);
});

it('carries immutable authority through both preparation/middleware/handler and preserves conditional owner decisions', async () => {
  const seen: unknown[] = [];
  const app = maximus<Record<string, never>>(configuration)
    .derive(async (context) => {
      seen.push(context.authority);
      return ok({ ready: true });
    })
    .use(async (context, proceed) => {
      seen.push(context.authority);
      return proceed();
    })
    .operation('readRecord', definition, async (context, value) => {
      seen.push(context.authority);
      if (value.managed && !context.authority?.scopes.includes('test:records:manage')) {
        return err(standardErrors.forbidden.create());
      }
      return ok(value);
    })
    .build();
  expect(
    (await executeOperation(app, app.operations.readRecord, {}, principal, { managed: false }, authority)).ok
  ).toBe(true);
  expect(seen).toHaveLength(3);
  expect(seen.every((value) => value === seen[0] && Object.isFrozen(value))).toBe(true);
  expect(
    (await executeOperation(app, app.operations.readRecord, {}, principal, { managed: true }, authority)).ok
  ).toBe(false);
  expect(
    (
      await executeOperation(
        app,
        app.operations.readRecord,
        {},
        principal,
        { managed: true },
        { ...authority, scopes: [...authority.scopes, 'test:records:manage'] }
      )
    ).ok
  ).toBe(true);
});

it('answers INTERNAL_ERROR, without running the handler, when preparation or middleware tries to widen the verified scopes', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const execute = vi.fn(async (_context: unknown, value: { managed: boolean }) => ok(value));
    /** Tries to grant the conditional scope the token lacks, as code that escapes the readonly type could. */
    const widen = (verified: InvocationAuthority | undefined) => {
      if (verified) {
        (verified.scopes as string[]).push('test:records:manage');
      }
    };
    const prepared = maximus<Record<string, never>>(configuration)
      .derive(async (context) => {
        widen(context.authority);
        return ok({});
      })
      .operation('readRecord', definition, execute)
      .build();
    const wrapped = maximus<Record<string, never>>(configuration)
      .use(async (context, proceed) => {
        widen(context.authority);
        return proceed();
      })
      .operation('readRecord', definition, execute)
      .build();
    for (const app of [prepared, wrapped]) {
      expect(
        await executeOperation(app, app.operations.readRecord, {}, principal, { managed: true }, authority)
      ).toEqual({ ok: false, error: standardErrors.internal.create() });
    }
    expect(execute).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

it('fails closed before preparation when conditional authority is absent or admission scope is missing', async () => {
  const prepare = vi.fn(async () => ok({}));
  const app = maximus<Record<string, never>>(configuration)
    .derive(prepare)
    .operation('readRecord', definition, async (_context, value) => ok(value))
    .build();
  expect(
    await executeOperation(app, app.operations.readRecord, {}, principal, { managed: false })
  ).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  expect(
    (
      await executeOperation(
        app,
        app.operations.readRecord,
        {},
        principal,
        { managed: false },
        { ...authority, scopes: [] }
      )
    ).ok
  ).toBe(false);
  expect(prepare).not.toHaveBeenCalled();
});

it('preserves ordinary RPC execution for operations without conditional authority', async () => {
  const { conditionalScopes: _unused, ...plain } = definition;
  const app = maximus<Record<string, never>>(configuration)
    .operation('readRecord', plain, async (context, value) => {
      expect(context.authority).toBeUndefined();
      return ok(value);
    })
    .build();
  expect((await executeOperation(app, app.operations.readRecord, {}, principal, { managed: false })).ok).toBe(
    true
  );
});

it('populates HTTP and authenticated transport contexts from verified claims rather than forged headers', async () => {
  const surfaces: unknown[] = [];
  const app = maximus<Record<string, never>>(configuration)
    .operation('readRecord', definition, async (context, value) => {
      expect(context.authority?.client.id).toBe('first-party');
      expect(context.authority?.scopes).toEqual(['test:records:read']);
      surfaces.push(context.authority?.surface);
      return value.managed ? err(standardErrors.forbidden.create()) : ok(value);
    })
    .build();
  const verify = async () => ({
    sub: 'person',
    org_id: organizationId,
    azp: 'first-party',
    scope: 'test:records:read',
    permissions: ['test:records:read'],
  });
  const request = (path: string, managed: boolean) =>
    new Request(`https://example.test${path}`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer a.b.c',
        'content-type': 'application/json',
        'x-client-id': 'forged',
        'x-delegation-scopes': 'test:records:manage',
      },
      body: JSON.stringify({ managed }),
    });
  const handle = createHttpHandler(app, { verify });
  expect((await handle(request('/v1/records/read', false), {})).status).toBe(200);
  expect((await handle(request('/v1/records/read', true), {})).status).toBe(403);
  const transported = createHttpHandler(app, {
    verify,
    transports: [
      {
        path: '/tools',
        scope: () => 'test:records:read',
        handle: async ({ invoke }) => {
          const result = await invoke('readRecord', app.operations.readRecord, { managed: false });
          return Response.json(result);
        },
      },
    ],
  });
  expect(await (await transported(request('/tools', false), {})).json()).toMatchObject({ ok: true });
  // Each call carries the surface whose admission verified its token.
  expect(surfaces).toEqual(['http', 'http', 'mcp']);
});

it('validates conditional declarations instead of accepting typos, collisions or another owner namespace', () => {
  for (const conditionalScopes of [
    [],
    ['test:records:read'],
    ['foreign:records:manage'],
    ['test:records:manage', 'test:records:manage'],
    ['test:bad'],
  ]) {
    expect(() =>
      maximus<Record<string, never>>(configuration)
        .operation('readRecord', { ...definition, conditionalScopes }, async (_context, value) => ok(value))
        .build()
    ).toThrow('Conditional scopes');
  }
});

it('a transport cannot run an operation outside the caller scopes when the token names no client', async () => {
  let ran = false;
  const app = maximus<Record<string, never>>(configuration)
    .operation(
      'deleteRecord',
      {
        scope: 'test:records:delete',
        title: 'Delete',
        description: 'Delete',
        effect: 'delete',
        input,
        output: input,
        http: { method: 'DELETE', path: '/v1/records/delete' },
      },
      (_context, value) => {
        ran = true;
        return Promise.resolve(ok(value));
      }
    )
    .build();
  // A person whose token grants only the transport's scope and names no client (no azp or client_id).
  const verify = async () => ({
    sub: 'person',
    org_id: organizationId,
    scope: 'test:records:read',
    permissions: ['test:records:read'],
  });
  const transported = createHttpHandler(app, {
    verify,
    transports: [
      {
        path: '/tools',
        scope: () => 'test:records:read',
        handle: async ({ invoke }) =>
          Response.json(await invoke('deleteRecord', app.operations.deleteRecord, { managed: false })),
      },
    ],
  });
  const response = await transported(
    new Request('https://example.test/tools', {
      method: 'POST',
      headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json' },
      body: '{}',
    }),
    {}
  );
  expect(await response.json()).toMatchObject({
    ok: false,
    error: { code: standardErrors.forbidden.create().code },
  });
  expect(ran).toBe(false);
});
