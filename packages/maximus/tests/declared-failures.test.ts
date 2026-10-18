/**
 * An operation's declared failures: they are all the failures its document lists, and any other domain
 * failure it answers becomes INTERNAL_ERROR.
 */
import { expect, it, vi } from 'vitest';

import { createHttpHandler, createOpenApi, defineErrors, err, maximus, ok, t } from '../src/index.ts';

const schema = t.Object({}, { additionalProperties: false });
const errors = defineErrors({
  notInstalled: { code: 'NOT_INSTALLED', status: 409, message: 'The product is not installed.' },
  locked: { code: 'LOCKED', status: 423, message: 'The record is locked.' },
});
function application() {
  return maximus<Record<string, never>>({
    name: 'fixture',
    namespace: 'fixture',
    title: 'Fixture',
    version: '1',
    origin: 'https://api.example.test',
    tokens: { issuer: 'https://issuer.example.test/', audience: 'https://api.example.test' },
    errors,
    rpc: { callers: [] },
    telemetry: { enabled: false },
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

it('documents only the failures an operation declares, and refuses any other at run time', async () => {
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
  const handle = createHttpHandler(app, {
    verify: async () => ({
      sub: 'person',
      azp: 'portal',
      org_id: 'org_1234567890abcdef',
      scope: 'fixture:records:read',
      permissions: ['fixture:records:read'],
    }),
  });
  const request = () =>
    new Request('https://api.example.test/v1/records', { headers: { authorization: 'Bearer a.b.c' } });
  expect((await handle(request(), {})).status).toBe(409);
  execute.mockResolvedValueOnce(err(errors.locked.create()) as never);
  expect((await handle(request(), {})).status).toBe(500);
  expect(() =>
    application()
      .operation('listRecords', { ...listRecords, failures: ['MISSING'] }, execute)
      .build()
  ).toThrow('failures');
});

it('documents every failure of the catalog when an operation declares none', () => {
  const app = application()
    .operation('listRecords', listRecords, async () => ok({}))
    .build();
  const responses =
    (createOpenApi(app) as { paths: Record<string, { get: { responses: Record<string, unknown> } }> }).paths[
      '/v1/records'
    ]?.get.responses ?? {};
  expect(Object.keys(responses)).toEqual(expect.arrayContaining(['409', '423']));
});
