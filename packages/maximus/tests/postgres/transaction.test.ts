/**
 * Tenant-scoped transactions with a fake pool: an invalid organization id and options out of bounds refused
 * before checkout, the isolation level BEGIN names, commit and release, a COMMIT the server answers with
 * ROLLBACK, rollback, failures without the values the server reported, uncertain commits, a pool that cannot
 * connect and opt-in database-only retries.
 */
import { DatabaseError } from 'pg';
import type { Pool, PoolClient } from 'pg';
import { expect, it, vi } from 'vite-plus/test';

import { classifyTransactionFailure } from '../../src/postgres/failures.ts';
import { withTenantTransaction } from '../../src/postgres/transaction.ts';
import type { TenantContext, TransactionOptions } from '../../src/postgres/transaction.ts';

const tenant = { organizationId: 'org_1234567890abcdef' };
const options = { statementTimeoutMs: 5000, lockTimeoutMs: 1000, idleTimeoutMs: 5000 };
function serverError(code: string) {
  const error = new DatabaseError('private database details', 0, 'error');
  error.code = code;
  return error;
}
/** A pool of one fake client: `fail` names what a statement throws, and COMMIT answers with `committed`. */
function fixture(fail?: (sql: string) => unknown, committed = 'COMMIT') {
  const query = vi.fn(async (sql: string) => {
    const failure = fail?.(sql);
    if (failure) {
      throw failure;
    }
    return { command: sql === 'COMMIT' ? committed : '', rows: [] };
  });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const connect = vi.fn(async () => client);
  return { pool: { connect } as Pick<Pool, 'connect'>, connect, query, release };
}

it('refuses an invalid organization id and options out of bounds with a TypeError, before checkout', async () => {
  const db = fixture();
  const work = vi.fn();
  const organization = 'A trusted organization identifier is required.';
  const budgets = 'Transaction time budgets must be between 1 and 60000 milliseconds.';
  const isolation = 'Unsupported isolation level.';
  const retries = 'Database retries require bounded attempts and delay.';
  // BEGIN names the isolation level as given, so only the three levels Postgres names may reach it.
  const injected: TransactionOptions = {
    ...options,
    // @ts-expect-error Any other isolation level is not the option's type either.
    isolation: 'serializable; DROP TABLE contacts',
  };
  const refusals: [TenantContext, TransactionOptions, string][] = [
    [{ organizationId: '' }, options, organization],
    [{ organizationId: '../another-org' }, options, organization],
    // A pattern test alone reads a list as its text, `org_1`.
    [{ organizationId: ['org_1'] as never }, options, organization],
    [tenant, { ...options, lockTimeoutMs: 0 }, budgets],
    [tenant, { ...options, statementTimeoutMs: 60_001 }, budgets],
    [tenant, injected, isolation],
    [tenant, { ...options, isolation: '' as never }, isolation],
    [tenant, { ...options, databaseOnlyRetry: { maxAttempts: 0, baseDelayMs: 1 } }, retries],
    [tenant, { ...options, databaseOnlyRetry: { maxAttempts: 6, baseDelayMs: 1 } }, retries],
    [tenant, { ...options, databaseOnlyRetry: { maxAttempts: 2, baseDelayMs: 0 } }, retries],
    [tenant, { ...options, databaseOnlyRetry: { maxAttempts: 2, baseDelayMs: 1001 } }, retries],
  ];
  for (const [authority, refused, message] of refusals) {
    await expect(
      withTenantTransaction(db.pool, authority, refused, work),
      JSON.stringify([authority, refused])
    ).rejects.toThrow(new TypeError(message));
  }
  expect(db.connect).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled();
});

it('begins at the isolation level the options name, and read committed without one', async () => {
  const db = fixture();
  await withTenantTransaction(db.pool, tenant, options, async () => null);
  await withTenantTransaction(db.pool, tenant, { ...options, isolation: 'serializable' }, async () => null);
  expect(db.query.mock.calls.map(([sql]) => sql).filter((sql) => sql.startsWith('BEGIN'))).toEqual([
    'BEGIN ISOLATION LEVEL read committed',
    'BEGIN ISOLATION LEVEL serializable',
  ]);
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

it('reports a COMMIT the server answered with ROLLBACK as a failure, and returns the connection to the pool', async () => {
  // Postgres answers COMMIT so when the work swallowed a failed statement: nothing was committed.
  const db = fixture(undefined, 'ROLLBACK');
  const result = await withTenantTransaction(db.pool, tenant, options, async () => 'effect');
  expect(result).toEqual({
    ok: false,
    error: {
      code: 'DATABASE_FAILURE',
      message: 'The database rolled back the transaction.',
      retryable: false,
      stage: 'commit',
    },
  });
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

it('answers a database failure by its SQLSTATE alone, never with the values the server reported', async () => {
  // Postgres names the values a statement refused: a violated key in the detail, a malformed value in the
  // message.
  const duplicate = serverError('23505');
  duplicate.detail = 'Key (org_id, id)=(org_1234567890abcdef, PATIENT_SENTINEL) already exists.';
  const malformed = serverError('22P02');
  malformed.message = 'invalid input syntax for type integer: "PATIENT_SENTINEL"';
  for (const [error, code] of [
    [duplicate, 'DATABASE_CONFLICT'],
    [malformed, 'DATABASE_FAILURE'],
  ] as const) {
    const result = await withTenantTransaction(fixture().pool, tenant, options, async () => {
      throw error;
    });
    expect(result).toMatchObject({ ok: false, error: { code, stage: 'work', sqlState: error.code } });
    expect(JSON.stringify(result)).not.toContain('PATIENT_SENTINEL');
  }
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

it('answers a pool that cannot connect as unavailable, without retrying or releasing anything', async () => {
  const db = fixture();
  db.connect.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.7:5432'));
  const work = vi.fn();
  const result = await withTenantTransaction(
    db.pool,
    tenant,
    { ...options, databaseOnlyRetry: { maxAttempts: 3, baseDelayMs: 1 } },
    work
  );
  expect(result).toEqual({
    ok: false,
    error: {
      code: 'DATABASE_UNAVAILABLE',
      message: 'The database is unavailable.',
      retryable: true,
      stage: 'connect',
    },
  });
  expect(db.connect).toHaveBeenCalledOnce();
  expect(db.release).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled();
});

it('retries proven aborts only with explicit database-only opt-in, and no more often than it allows', async () => {
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
  // An abort on every attempt is answered once the attempts run out.
  const exhausted = fixture();
  const aborted = await withTenantTransaction(
    exhausted.pool,
    tenant,
    { ...options, databaseOnlyRetry: { maxAttempts: 2, baseDelayMs: 1 } },
    async () => {
      throw serverError('40001');
    }
  );
  expect(aborted).toMatchObject({ ok: false, error: { code: 'DATABASE_RETRY', sqlState: '40001' } });
  expect(exhausted.connect).toHaveBeenCalledTimes(2);
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
