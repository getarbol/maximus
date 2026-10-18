/**
 * Worker RPC in workerd: the entrypoint admits only callers its Service Binding props name, checks the
 * forwarded principal and fails closed for conditional operations.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';

const principal = {
  actorId: 'person',
  actorKind: 'user',
  organizationId: 'org_1234567890abcdef',
  requestId: '00000000-0000-4000-8000-000000000001',
};

let runtime: Miniflare;
let directory: string;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'maximus-rpc-'));
  const output = join(directory, 'owner.mjs');
  execFileSync(
    'bun',
    [
      'build',
      'tests/workers/fixtures/rpc-owner.ts',
      '--target=browser',
      '--external=cloudflare:workers',
      '--external=node:*',
      '--outfile',
      output,
    ],
    { stdio: 'pipe' }
  );
  const binding = (props: Record<string, unknown>) => ({
    name: 'owner',
    entrypoint: 'InternalEntrypoint',
    props,
  });
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'caller',
          modules: true,
          compatibilityDate: '2026-10-03',
          compatibilityFlags: ['nodejs_compat'],
          serviceBindings: {
            INTERNAL: binding({ caller: 'internal' }),
            REPORTS: binding({ caller: 'reports' }),
            EXTRA: binding({ caller: 'internal', mode: 'admitted' }),
            STRANGER: binding({ caller: 'stranger' }),
          },
          script: `export default { async fetch(request, env) {
        const { binding, method, principal, input } = await request.json();
        return Response.json(await env[binding][method](principal, input));
      }};`,
        },
        {
          name: 'owner',
          modules: true,
          compatibilityDate: '2026-10-03',
          compatibilityFlags: ['nodejs_compat'],
          script: readFileSync(output, 'utf-8'),
        },
      ],
    })
  );
  await runtime.ready;
}, 30_000);
afterAll(async () => {
  await runtime?.dispose();
  if (directory) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function call(binding: string, method: string, body: { principal?: unknown; input?: unknown } = {}) {
  return (
    await runtime.dispatchFetch('https://fixture.test/', {
      method: 'POST',
      body: JSON.stringify({ binding, method, principal, input: { managed: false }, ...body }),
    })
  ).json();
}

it('runs an operation for a caller its binding props name, with the forwarded principal', async () => {
  expect(await call('INTERNAL', 'internalRead')).toEqual({
    ok: true,
    value: { organizationId: 'org_1234567890abcdef', managed: false },
  });
});

it('refuses props that are not exactly an admitted caller, and a malformed principal', async () => {
  // Another application caller the operation does not name, extra props, and an unknown caller.
  for (const binding of ['REPORTS', 'EXTRA', 'STRANGER']) {
    expect(await call(binding, 'internalRead')).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
  }
  for (const forged of [
    { ...principal, organizationId: 'acme/other' },
    { ...principal, scopes: ['fixture:internal:manage'] },
    { ...principal, requestId: 'not-a-uuid' },
  ]) {
    expect(await call('INTERNAL', 'internalRead', { principal: forged })).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHORIZED' },
    });
  }
  expect(await call('INTERNAL', 'internalRead', { input: { managed: 'yes' } })).toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT' },
  });
});

it('fails closed over ordinary RPC for an operation with conditional scopes', async () => {
  expect(await call('REPORTS', 'conditionalRead')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
});
