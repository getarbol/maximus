/**
 * Per-organization credentials: read and checked once, failing closed when missing, invalid or another
 * organization's.
 */
import { expect, it, vi } from 'vitest';

import { t, ok, err, standardErrors } from '../../src/index.ts';
import { credentials } from '../../src/workers/credentials.ts';

const schema = t.Object(
  { organizationId: t.String(), password: t.String() },
  { additionalProperties: false }
);
const principal = {
  organizationId: 'org_1234567890abcdef',
  actorId: 'test',
  actorKind: 'service' as const,
  requestId: crypto.randomUUID(),
};
const credential = { organizationId: principal.organizationId, password: 'PRIVATE_SENTINEL' };
it('resolves and validates organization credentials once with inferred fields', async () => {
  const readCredential = vi.fn(async () => ok(credential));
  const getByName = vi.fn(() => ({ readCredential }));
  const result = await credentials({ principal, schema, accounts: { getByName } });
  expect(result).toEqual(ok({ credential }));
  if (!result.ok) {
    return;
  }
  expect(readCredential).toHaveBeenCalledExactlyOnceWith(principal.organizationId);
  expect(getByName).toHaveBeenCalledExactlyOnceWith(principal.organizationId);
  // @ts-expect-error A field not in the credential schema is unavailable.
  void result.value.credential.missing;
  // @ts-expect-error Credential fields retain their inferred types.
  const invalid: number = result.value.credential.password;
  void invalid;
});
it('fails closed for missing, invalid and cross-organization credentials', async () => {
  for (const result of [
    err(standardErrors.notFound.create()),
    ok({ ...credential, organizationId: 'org_other' }),
    ok({ password: 'PRIVATE_SENTINEL' }),
  ]) {
    const resolved = await credentials({
      principal,
      schema,
      accounts: { getByName: () => ({ readCredential: async () => result }) },
    });
    expect(resolved.ok).toBe(false);
    expect(JSON.stringify(resolved)).not.toContain('PRIVATE_SENTINEL');
  }
});
