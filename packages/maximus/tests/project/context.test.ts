/**
 * The context every handler receives, as context.ts declares it with defineContext: values prepared once per
 * call after admission, `fail` answering the call instead, and binding refusing any other export.
 */
import { expect, it } from 'vite-plus/test';

import {
  createHttpHandler,
  defineAuth,
  defineContext,
  err,
  maximus,
  ok,
  standardErrors,
  t,
} from '../../src/index.ts';
import { bindContext } from '../../src/project/config.ts';
import { errors } from './fixtures/registered.ts';
import type { Env } from './fixtures/registered.ts';

/** The development token the policy accepts from localhost. */
const TOKEN = 'local-development-token-0123456789';
const env: Env = { PREFIX: 'Task', DEVELOPMENT_TOKEN: TOKEN };

/** A tasks service whose development token acts in the given organization. */
function application(organizationId = 'org_acme') {
  return maximus<Env>({
    name: 'tasks',
    namespace: 'tasks',
    title: 'Tasks',
    version: '1',
    origin: 'https://tasks.example.test',
    tokens: {
      issuer: 'https://issuer.example.test/',
      audience: 'https://tasks.example.test',
      development: { binding: 'DEVELOPMENT_TOKEN', organizationId },
    },
    errors,
    rpc: { callers: [] },
    telemetry: { enabled: false },
  });
}

const context = defineContext(({ env: bindings, principal, fail }) =>
  principal.organizationId === 'org_blocked'
    ? fail('FORBIDDEN')
    : { label: `${bindings.PREFIX} for ${principal.organizationId}` }
);
const empty = t.Object({}, { additionalProperties: false });

/** Reads the label the context prepared, over HTTP with the development token. */
async function readLabel(organizationId?: string) {
  const app = bindContext(application(organizationId), context)
    .operation(
      'readLabel',
      {
        scope: 'tasks:labels:read',
        title: 'Read the label',
        description: 'Answer the label the context prepared.',
        effect: 'read',
        input: empty,
        output: t.Object({ label: t.String() }, { additionalProperties: false }),
        http: { method: 'GET', path: '/v1/labels' },
      },
      async ({ label }) => ok({ label })
    )
    .build();
  const response = await createHttpHandler(app)(
    new Request('http://localhost:5173/v1/labels', { headers: { authorization: `Bearer ${TOKEN}` } }),
    env
  );
  return { status: response.status, body: await response.json() };
}

it('adds what context.ts prepares to every handler', async () => {
  expect(await readLabel()).toMatchObject({ status: 200, body: { data: { label: 'Task for org_acme' } } });
});

it('answers the call with the failure the context returns', async () => {
  expect(await readLabel('org_blocked')).toMatchObject({
    status: 403,
    body: { error: { code: 'FORBIDDEN' } },
  });
});

it('refuses a context.ts default export that defineContext did not declare', () => {
  expect(() => bindContext(application(), { prepare: () => ({}) })).toThrow(
    "context.ts's default export must come from defineContext."
  );
});

it('refuses configuration in auth.ts, which would override the token policy vite.config.ts states', () => {
  const resolve = async () => err(standardErrors.unauthorized.create());
  const options = { resolve, issuer: 'https://issuer.elsewhere.test/', development: { binding: 'OTHER' } };
  // @ts-expect-error The issuer and the development token are configuration, beside resolve as well.
  expect(() => defineAuth(options)).toThrow(
    'auth.ts states how tokens are verified in code; configure issuer, development in vite.config.ts.'
  );
});

it('verifies the tokens auth.ts resolves itself, as the configuration completes it', async () => {
  const auth = defineAuth({
    resolve: async (token) =>
      token === 'service-key-0123456789abcdef'
        ? ok({
            actorId: 'billing',
            actorKind: 'service' as const,
            organizationId: 'org_acme',
            scopes: ['tasks:labels:read'],
          })
        : err(standardErrors.unauthorized.create()),
  });
  expect(Object.isFrozen(auth)).toBe(true);
  const app = maximus<Env>({
    name: 'tasks',
    namespace: 'tasks',
    title: 'Tasks',
    version: '1',
    origin: 'https://tasks.example.test',
    tokens: {
      audience: 'https://tasks.example.test',
      scheme: { type: 'bearer', description: 'Service keys.' },
      ...auth,
    },
    errors,
    rpc: { callers: [] },
    telemetry: { enabled: false },
  })
    .operation(
      'whoAmI',
      {
        scope: 'tasks:labels:read',
        title: 'Who am I',
        description: 'Answer the calling actor.',
        effect: 'read',
        input: empty,
        output: t.Object({ actorId: t.String() }, { additionalProperties: false }),
        http: { method: 'GET', path: '/v1/me' },
      },
      async ({ principal }) => ok({ actorId: principal.actorId })
    )
    .build();
  const call = async (token: string) =>
    createHttpHandler(app)(
      new Request('https://tasks.example.test/v1/me', { headers: { authorization: `Bearer ${token}` } }),
      env
    );
  expect(await (await call('service-key-0123456789abcdef')).json()).toMatchObject({
    data: { actorId: 'billing' },
  });
  expect((await call('another-key')).status).toBe(401);
});
