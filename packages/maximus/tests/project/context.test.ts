/**
 * The context every handler receives, as context.ts declares it with defineContext: values prepared once per
 * call after admission, `fail` answering the call instead, and binding refusing any other export. Beside it,
 * the other code that completes the application: auth.ts (defineAuth) and telemetry.ts (defineTelemetry).
 */
import { expect, it } from 'vite-plus/test';

import {
  createHttpHandler,
  defineAuth,
  defineContext,
  defineTelemetry,
  err,
  maximus,
  ok,
  standardErrors,
  t,
} from '../../src/index.ts';
import type { TelemetryConfig } from '../../src/index.ts';
import { bindContext } from '../../src/project/config.ts';
import { errors } from './fixtures/registered.ts';
import type { Env } from './fixtures/registered.ts';

/** The development token the policy accepts from localhost. */
const TOKEN = 'local-development-token-0123456789';
const env: Env = { PREFIX: 'Task', DEVELOPMENT_TOKEN: TOKEN };

/** A tasks service whose development token acts in the given organization, with telemetry off unless given. */
function application(organizationId = 'org_acme', telemetry: TelemetryConfig<Env> = { enabled: false }) {
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
    telemetry,
  });
}

const context = defineContext(({ env: bindings, principal, fail }) =>
  principal.organizationId === 'org_blocked'
    ? fail('FORBIDDEN')
    : { label: `${bindings.PREFIX} for ${principal.organizationId}` }
);
const empty = t.Object({}, { additionalProperties: false });

/** The label operation over the context, in a service with the given telemetry. */
function labels(organizationId?: string, telemetry?: TelemetryConfig<Env>) {
  return bindContext(application(organizationId, telemetry), context)
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
}

/** The label request, with the development token. */
const labelRequest = () =>
  new Request('http://localhost:5173/v1/labels', { headers: { authorization: `Bearer ${TOKEN}` } });

/** Reads the label the context prepared, over HTTP with the development token. */
async function readLabel(organizationId?: string) {
  const response = await createHttpHandler(labels(organizationId))(labelRequest(), env);
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

it('refuses in telemetry.ts what is not telemetry, and hands its observers each call while it is on', async () => {
  expect(() =>
    // @ts-expect-error A dataset is a binding vite.config.ts declares; telemetry.ts states code.
    defineTelemetry({ observers: [], dataset: 'events' })
  ).toThrow('telemetry.ts states only enabled, observers and traceId: remove dataset.');
  const observed: string[] = [];
  const telemetry = defineTelemetry({
    enabled: (bindings) => bindings.PREFIX !== 'Quiet',
    observers: [
      {
        execution: async ({ operation, outcome, surface }) =>
          observed.push(`${surface} ${operation} ${outcome}`),
      },
    ],
  });
  expect(Object.isFrozen(telemetry)).toBe(true);
  const handler = createHttpHandler(labels('org_acme', telemetry));
  const pending: Promise<unknown>[] = [];
  const background = {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
  };
  expect((await handler(labelRequest(), env, background)).status).toBe(200);
  expect((await handler(labelRequest(), { ...env, PREFIX: 'Quiet' }, background)).status).toBe(200);
  await Promise.all(pending);
  expect(observed).toEqual(['http readLabel success']);
});
