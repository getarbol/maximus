/**
 * The development token: accepted only from a local host and only when long enough, as a developer holding
 * every scope the application declares, while every other token is verified as before.
 */
import { expect, it } from 'vite-plus/test';

import { createHttpHandler, defineErrors, maximus, ok, t } from '../src/index.ts';
import type { TokenPolicy } from '../src/index.ts';

/** The bindings the development token is read from. */
interface Env {
  DEVELOPMENT_TOKEN?: string;
}

/** A development token as `.dev.vars` would hold it: at least 32 characters. */
const TOKEN = 'local-development-token-0123456789';
const empty = t.Object({}, { additionalProperties: false });
const caller = t.Object(
  { actorId: t.String(), organizationId: t.String(), scopes: t.Array(t.String()) },
  { additionalProperties: false }
);

/** A notes service whose one operation answers who called it. */
function application(tokens: TokenPolicy<Env>) {
  return maximus<Env>({
    name: 'notes',
    namespace: 'notes',
    title: 'Notes',
    version: '1',
    origin: 'https://notes.example.test',
    tokens,
    errors: defineErrors({}),
    rpc: { callers: [] },
    telemetry: { enabled: false },
  })
    .operation(
      'whoAmI',
      {
        scope: 'notes:notes:read',
        title: 'Who am I',
        description: 'Answer the calling principal.',
        effect: 'read',
        input: empty,
        output: caller,
        http: { method: 'POST', path: '/v1/notes/who-am-i' },
      },
      async (context) =>
        ok({
          actorId: context.principal.actorId,
          organizationId: context.principal.organizationId,
          scopes: [...(context.authority?.scopes ?? [])],
        })
    )
    .build();
}

/** The development token's binding, as `.dev.vars` sets it for `cf dev`. */
const development = { binding: 'DEVELOPMENT_TOKEN' };
const tokens: TokenPolicy<Env> = {
  issuer: 'https://issuer.example.test/',
  audience: 'https://notes.example.test',
  development,
};

/** The HTTP handler of a notes service. */
type Handler = (request: Request, env: Env) => Promise<Response>;
/** What the operation answers: the calling principal. */
interface Answer {
  data: { actorId: string; organizationId: string; scopes: string[] };
}

/** Calls the operation at `origin` with a bearer token. */
async function call(handle: Handler, origin: string, token: string, env: Env) {
  return await handle(
    new Request(`${origin}/v1/notes/who-am-i`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    }),
    env
  );
}

it('admits the development token from a local host as a developer holding every declared scope', async () => {
  const handle = createHttpHandler(application(tokens));
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173']) {
    const response = await call(handle, origin, TOKEN, { DEVELOPMENT_TOKEN: TOKEN });
    expect(response.status, origin).toBe(200);
    expect(((await response.json()) as Answer).data).toEqual({
      actorId: 'local-developer',
      organizationId: 'local-development',
      scopes: ['notes:notes:read'],
    });
  }
});

it('acts in the organization the policy names', async () => {
  const handle = createHttpHandler(
    application({ ...tokens, development: { ...development, organizationId: 'org_acme' } })
  );
  const response = await call(handle, 'http://localhost:5173', TOKEN, { DEVELOPMENT_TOKEN: TOKEN });
  expect(((await response.json()) as Answer).data.organizationId).toBe('org_acme');
});

it('never admits it from another host, when it is short, absent or another token', async () => {
  const handle = createHttpHandler(application(tokens));
  const short = TOKEN.slice(0, 31);
  for (const [origin, token, env] of [
    ['https://notes.example.test', TOKEN, { DEVELOPMENT_TOKEN: TOKEN }],
    ['http://localhost.example.test', TOKEN, { DEVELOPMENT_TOKEN: TOKEN }],
    ['http://localhost:5173', short, { DEVELOPMENT_TOKEN: short }],
    ['http://localhost:5173', TOKEN, {}],
    ['http://localhost:5173', `${TOKEN}x`, { DEVELOPMENT_TOKEN: TOKEN }],
  ] as const) {
    expect((await call(handle, origin, token, env)).status, `${origin} ${token.length}`).toBe(401);
  }
});

it('still verifies every other token as an OAuth access token', async () => {
  const claims = {
    sub: 'user-1',
    client_id: 'web',
    org_id: 'org_acme',
    scope: 'notes:notes:read',
    permissions: ['notes:notes:read'],
  };
  const handle = createHttpHandler(application(tokens), { verify: async () => claims });
  const response = await call(handle, 'https://notes.example.test', 'a.b.c', { DEVELOPMENT_TOKEN: TOKEN });
  expect(response.status).toBe(200);
  expect(((await response.json()) as Answer).data).toMatchObject({
    actorId: 'user-1',
    organizationId: 'org_acme',
  });
});

it('refuses at build time a development token without a binding, or with an invalid organization', () => {
  for (const invalid of [
    { binding: '' },
    { binding: 42 },
    { binding: 'DEVELOPMENT_TOKEN', organizationId: 'org/acme' },
  ]) {
    expect(() => application({ ...tokens, development: invalid } as TokenPolicy<Env>)).toThrow(TypeError);
  }
});
