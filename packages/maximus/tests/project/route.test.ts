/**
 * createRoute, the 7.4 defineRoute helper a project's generated routes.ts exports: a named method declaration
 * binds to the shared base under the path and method its file and export name give it, keeps its other HTTP
 * options and the base's context, and may not claim the path or the method itself.
 */
import { expect, it } from 'vite-plus/test';

import { createHttpHandler, defineErrors, maximus, ok, t } from '../../src/index.ts';
import { createRoute } from '../../src/project/route.ts';

interface Env {
  DEVELOPMENT_TOKEN: string;
}

/** The development token the policy accepts from localhost: every declared scope. */
const TOKEN = 'local-development-token-0123456789';
const env: Env = { DEVELOPMENT_TOKEN: TOKEN };

/** The base generated code derives every route from, with the context it prepares. */
const base = maximus<Env>({
  name: 'notes',
  namespace: 'notes',
  title: 'Notes',
  version: '1',
  origin: 'https://notes.example.test',
  tokens: {
    issuer: 'https://issuer.example.test/',
    audience: 'https://notes.example.test',
    development: { binding: 'DEVELOPMENT_TOKEN' },
  },
  errors: defineErrors({}),
  rpc: { callers: [] },
  telemetry: { enabled: false },
}).derive(async () => ok({ salutation: 'Hello' }));
const defineRoute = createRoute(base);

const greeting = {
  title: 'Greet',
  description: 'Greet someone by name.',
  scope: 'notes:greetings:write',
  effect: 'write' as const,
  input: t.Object({ name: t.String() }, { additionalProperties: false }),
  output: t.Object({ message: t.String() }, { additionalProperties: false }),
};

it('binds a method export under its file path and method, keeping its HTTP options and the base context', async () => {
  const POST = defineRoute('greet', { ...greeting, http: { successStatus: 201 } }, async (context, input) =>
    ok({ message: `${context.salutation}, ${input.name}` })
  );
  const app = base.mount(POST('/v1/greetings', 'POST')).build();
  expect(app.operations.greet.http).toEqual({ successStatus: 201, path: '/v1/greetings', method: 'POST' });
  const response = await createHttpHandler(app)(
    new Request('http://localhost:5173/v1/greetings', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    }),
    env
  );
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ success: true, data: { message: 'Hello, Ada' } });
});

it('gives a declaration without HTTP options its path and method alone', () => {
  const PUT = defineRoute('replaceGreeting', greeting, async (_context, input) =>
    ok({ message: input.name })
  );
  const app = base.mount(PUT('/v1/greetings/current', 'PUT')).build();
  expect(app.operations.replaceGreeting.http).toEqual({ path: '/v1/greetings/current', method: 'PUT' });
});

it('refuses a declaration that claims the path or the method its file and export own', () => {
  const execute = async () => ok({ message: '' });
  const refusal = new TypeError('The route filename and method export own http.path and http.method.');
  expect(() =>
    // @ts-expect-error The path belongs to the route's file.
    defineRoute('greet', { ...greeting, http: { path: '/v1/elsewhere' } }, execute)
  ).toThrow(refusal);
  expect(() =>
    // @ts-expect-error The method belongs to the route's export.
    defineRoute('greet', { ...greeting, http: { method: 'PUT', successStatus: 200 } }, execute)
  ).toThrow(refusal);
});
