/**
 * Tenant-scoped transactions with a fake pool: option checks before checkout, commit and release,
 * rollback, uncertain commits and opt-in database-only retries.
 */
import { DatabaseError } from 'pg';
import type { Pool, PoolClient } from 'pg';
import { expect, it, vi } from 'vite-plus/test';

import { classifyTransactionFailure } from '../../src/postgres/failures.ts';
import { withTenantTransaction } from '../../src/postgres/transaction.ts';

const tenant = { organizationId: 'org_1234567890abcdef' };
const options = { statementTimeoutMs: 5000, lockTimeoutMs: 1000, idleTimeoutMs: 5000 };
function serverError(code: string) {
  const error = new DatabaseError('private database details', 0, 'error');
  error.code = code;
  return error;
}
function fixture(fail?: (sql: string) => unknown) {
  const query = vi.fn(async (sql: string) => {
    const failure = fail?.(sql);
    if (failure) {
      throw failure;
    }
    return { command: sql === 'COMMIT' ? 'COMMIT' : '', rows: [] };
  });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const connect = vi.fn(async () => client);
  return { pool: { connect } as Pick<Pool, 'connect'>, connect, query, release };
}

it('refuses absent/invalid tenant authority and unbounded options before checkout', async () => {
  const db = fixture();
  const work = vi.fn();
  await expect(withTenantTransaction(db.pool, { organizationId: '' }, options, work)).rejects.toThrow(
    'trusted'
  );
  await expect(
    withTenantTransaction(db.pool, tenant, { ...options, lockTimeoutMs: 0 }, work)
  ).rejects.toThrow('budgets');
  expect(db.connect).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled();
});

it('passes frozen tenant authority, commits and releases without installing RLS/session tenant state', async () => {
  const db = fixture();
  const result = await withTenantTransaction(db.pool, tenant, options, async (_client, authority) => {
    expect(Object.isFrozen(authority)).toBe(true);
    return authority.organizationId;
  });
  expect(result).toEqual({ ok: true, value: tenant.organizationId });
  expect(db.query.mock.calls.map(([sql]) => sql).join(' ')).not.toMatch(
    /ROW LEVEL SECURITY|app\.organization_id/
  );
  expect(db.release).toHaveBeenCalledExactlyOnceWith(false);
});

it('preserves unexpected owner errors, rolls back and always releases', async () => {
  const db = fixture();
  const error = new Error('owner bug');
  await expect(
    withTenantTransaction(db.pool, tenant, options, async () => {
      throw error;
    })
  ).rejects.toBe(error);
  expect(db.query).toHaveBeenLastCalledWith('ROLLBACK');
  expect(db.release).toHaveBeenCalledExactlyOnceWith(false);
});

it('never replays or returns a potentially committed connection to the pool', async () => {
  const db = fixture((sql) => (sql === 'COMMIT' ? new Error('socket lost') : undefined));
  const work = vi.fn(async () => 'effect');
  const result = await withTenantTransaction(
    db.pool,
    tenant,
    { ...options, databaseOnlyRetry: { maxAttempts: 3, baseDelayMs: 1 } },
    work
  );
  expect(result).toMatchObject({ ok: false, error: { code: 'COMMIT_UNCERTAIN', retryable: false } });
  expect(work).toHaveBeenCalledOnce();
  expect(db.release).toHaveBeenCalledExactlyOnceWith(true);
  expect(JSON.stringify(result)).not.toContain('socket lost');
});

it('retries proven aborts only with explicit database-only opt-in', async () => {
  const db = fixture();
  let attempts = 0;
  const work = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw serverError('40001');
    }
    return 'done';
  };
  expect(
    await withTenantTransaction(
      db.pool,
      tenant,
      { ...options, databaseOnlyRetry: { maxAttempts: 2, baseDelayMs: 1 } },
      work
    )
  ).toEqual({ ok: true, value: 'done' });
  expect(db.connect).toHaveBeenCalledTimes(2);
  expect(db.release).toHaveBeenCalledTimes(2);
  const once = fixture();
  const rejected = await withTenantTransaction(once.pool, tenant, options, async () => {
    throw serverError('40P01');
  });
  expect(rejected).toMatchObject({ ok: false, error: { code: 'DATABASE_RETRY' } });
  expect(once.connect).toHaveBeenCalledOnce();
});

it('discards a connection if rollback fails and does not retry', async () => {
  const db = fixture((sql) => (sql === 'ROLLBACK' ? new Error('disconnected') : undefined));
  const result = await withTenantTransaction(
    db.pool,
    tenant,
    { ...options, databaseOnlyRetry: { maxAttempts: 3, baseDelayMs: 1 } },
    async () => {
      throw serverError('40001');
    }
  );
  expect(result).toMatchObject({ ok: false, error: { code: 'DATABASE_RETRY' } });
  expect(db.connect).toHaveBeenCalledOnce();
  expect(db.release).toHaveBeenCalledExactlyOnceWith(true);
});

it('classifies SQLSTATE from actual server errors and treats commit disconnect/cancellation as uncertain', () => {
  expect(classifyTransactionFailure({ code: '40001', message: 'serialization' }, 'commit').code).toBe(
    'COMMIT_UNCERTAIN'
  );
  for (const code of ['08006', '40003', '57P01']) {
    expect(classifyTransactionFailure(serverError(code), 'commit').code).toBe('COMMIT_UNCERTAIN');
  }
  expect(classifyTransactionFailure(serverError('23505'), 'work')).toMatchObject({
    code: 'DATABASE_CONFLICT',
    sqlState: '23505',
    retryable: false,
  });
  expect(classifyTransactionFailure(serverError('40001'), 'commit').code).toBe('DATABASE_RETRY');
});
