/**
 * An operation's failures: those it declares are all the failures its document lists, and any other domain
 * failure its handler or context answers, or one the catalog does not define, becomes INTERNAL_ERROR without
 * its text.
 */
import { expect, it, vi } from 'vite-plus/test';

import { createHttpHandler, createOpenApi, defineErrors, err, maximus, ok, t } from '../src/index.ts';
import type { Failure, TelemetryConfig } from '../src/index.ts';

const schema = t.Object({}, { additionalProperties: false });
const errors = defineErrors({
  notInstalled: { code: 'NOT_INSTALLED', status: 409, message: 'The product is not installed.' },
  locked: { code: 'LOCKED', status: 423, message: 'The record is locked.' },
});
/** A person of the organization that may read records. */
const claims = {
  sub: 'person',
  azp: 'portal',
  org_id: 'org_1234567890abcdef',
  scope: 'fixture:records:read',
  permissions: ['fixture:records:read'],
};
/** A fixture service with the telemetry given, off by default. */
function application(telemetry: TelemetryConfig<Record<string, never>> = { enabled: false }) {
  return maximus<Record<string, never>>({
    name: 'fixture',
    namespace: 'fixture',
    title: 'Fixture',
    version: '1',
    origin: 'https://api.example.test',
    tokens: { issuer: 'https://issuer.example.test/', audience: 'https://api.example.test' },
    errors,
    rpc: { callers: [] },
    telemetry,
  });
}
const listRecords = {
  title: 'Records',
  description: 'Records of the organization.',
  effect: 'read',
  scope: 'fixture:records:read',
  input: schema,
  output: schema,
  http: { method: 'GET', path: '/v1/records' },
  actorKinds: ['user'],
} as const;
/** A call to `listRecords` with a token. */
const list = () =>
  new Request('https://api.example.test/v1/records', { headers: { authorization: 'Bearer a.b.c' } });

it('documents only the failures an operation declares, and refuses any other its handler or context answers', async () => {
  const execute = vi.fn(async () => err(errors.notInstalled.create()));
  const app = application()
    .operation('listRecords', { ...listRecords, failures: ['NOT_INSTALLED'] }, execute)
    .build();
  const responses =
    (createOpenApi(app) as { paths: Record<string, { get: { responses: Record<string, unknown> } }> }).paths[
      '/v1/records'
    ]?.get.responses ?? {};
  expect(Object.keys(responses)).toContain('409');
  expect(Object.keys(responses)).not.toContain('423');
  const handle = createHttpHandler(app, { verify: async () => claims });
  expect((await handle(list(), {})).status).toBe(409);
  execute.mockResolvedValueOnce(err(errors.locked.create()) as never);
  expect((await handle(list(), {})).status).toBe(500);
  expect(() =>
    application()
      .operation('listRecords', { ...listRecords, failures: ['MISSING'] }, execute)
      .build()
  ).toThrow('failures');
  // A failure its context answers is held to the same declaration, while a standard one is always allowed.
  const prepared = async (failure: Failure) =>
    (
      await createHttpHandler(
        application()
          .derive(async () => err(failure))
          .operation('listRecords', { ...listRecords, failures: ['NOT_INSTALLED'] }, async () => ok({}))
          .build(),
        { verify: async () => claims }
      )(list(), {})
    ).status;
  expect(await prepared(errors.notInstalled.create())).toBe(409);
  expect(await prepared(errors.forbidden.create())).toBe(403);
  expect(await prepared(errors.locked.create())).toBe(500);
});

it('answers a failure the catalog does not define as INTERNAL_ERROR, from a handler or a derivation, never with its text', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    // A catalog code with a message of its own, a code the catalog lacks, and a catalog code with data
    // it does not declare.
    const outside: Failure[] = [
      { ...errors.notFound.create(), message: 'Patient Jane Doe not found' },
      { code: 'DB_DOWN', message: 'DB_DOWN at 10.0.0.7', retryable: true, data: {} },
      { ...errors.notInstalled.create(), data: { patient: 'Patient Jane Doe' } },
    ];
    for (const failure of outside) {
      const answered = application({})
        .operation('listRecords', listRecords, async () => err(failure))
        .build();
      const derived = application({})
        .derive(async () => err(failure))
        .operation('listRecords', listRecords, async () => ok({}))
        .build();
      for (const app of [answered, derived]) {
        const response = await createHttpHandler(app, { verify: async () => claims })(list(), {});
        expect(response.status, failure.code).toBe(500);
        const text = await response.text();
        expect(JSON.parse(text)).toMatchObject({ error: errors.internal.create() });
        expect(text).not.toMatch(/Jane Doe|10\.0\.0\.7/);
      }
    }
    // Each is reported by its safe description alone.
    expect(logged).toHaveBeenCalledTimes(6);
    for (const [line] of logged.mock.calls) {
      expect(JSON.parse(String(line))).toMatchObject({ event: 'maximus.unexpected', surface: 'operation' });
    }
    expect(JSON.stringify([logged.mock.calls, warned.mock.calls])).not.toMatch(/Jane Doe|10\.0\.0\.7/);
  } finally {
    logged.mockRestore();
    warned.mockRestore();
  }
});
