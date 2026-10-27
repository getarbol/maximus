/**
 * Short tenant-scoped Postgres transactions on one checked-out client, with time budgets and opt-in
 * database-only retries.
 */
import { setTimeout as delay } from 'node:timers/promises';

import type { Pool, PoolClient } from 'pg';

import { classifyTransactionFailure } from './failures.ts';
import type { TransactionFailure, TransactionStage } from './failures.ts';

/** A verified organization id; the same rule as the core's `OrganizationIdSchema`, which this entry does not import. */
const ORGANIZATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The organization a transaction works for, taken from the verified principal. */
export interface TenantContext {
  /**
   * The trusted organization id (1 to 128 letters, digits, `_` and `-`, starting with a letter or digit) that
   * every query in the callback must filter by; any other form is refused.
   */
  readonly organizationId: string;
}
/** The time budgets, isolation level and opt-in database-only retries of a transaction. */
export interface TransactionOptions {
  /**
   * How long one statement may run before Postgres aborts it (`statement_timeout`), in milliseconds from 1 to
   * 60000.
   */
  statementTimeoutMs: number;
  /**
   * How long a statement may wait for a lock before Postgres aborts it (`lock_timeout`), in milliseconds from
   * 1 to 60000.
   */
  lockTimeoutMs: number;
  /**
   * How long the transaction may wait idle for its next statement before Postgres ends the session
   * (`idle_in_transaction_session_timeout`), in milliseconds from 1 to 60000.
   */
  idleTimeoutMs: number;
  /** The transaction's isolation level; `read committed` when absent. */
  isolation?: 'read committed' | 'repeatable read' | 'serializable';
  /** Opt in only when the callback performs database work exclusively. Defaults to one attempt. */
  databaseOnlyRetry?: { maxAttempts: number; baseDelayMs: number };
}
/** The work's value, or a classified failure. */
export type TransactionResult<T> = { ok: true; value: T } | { ok: false; error: TransactionFailure };

/**
 * Refuses an organization id that is not one, time budgets outside 1 to 60000 ms, an unknown isolation level
 * and unbounded retries.
 */
function validateOptions(tenant: TenantContext, options: TransactionOptions) {
  // A pattern test reads any value as text: `['org_1']` would pass it, so the type is checked first.
  if (typeof tenant.organizationId !== 'string' || !ORGANIZATION_ID.test(tenant.organizationId)) {
    throw new TypeError('A trusted organization identifier is required.');
  }
  for (const value of [options.statementTimeoutMs, options.lockTimeoutMs, options.idleTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
      throw new TypeError('Transaction time budgets must be between 1 and 60000 milliseconds.');
    }
  }
  if (
    options.isolation !== undefined &&
    !['read committed', 'repeatable read', 'serializable'].includes(options.isolation)
  ) {
    throw new TypeError('Unsupported isolation level.');
  }
  const retry = options.databaseOnlyRetry;
  if (
    retry &&
    (!Number.isSafeInteger(retry.maxAttempts) ||
      retry.maxAttempts < 1 ||
      retry.maxAttempts > 5 ||
      !Number.isSafeInteger(retry.baseDelayMs) ||
      retry.baseDelayMs < 1 ||
      retry.baseDelayMs > 1000)
  ) {
    throw new TypeError('Database retries require bounded attempts and delay.');
  }
}

/**
 * Run short owner SQL on one checked-out client, passing trusted tenant context explicitly.
 * Owners enforce organization predicates and composite keys; this helper does not install RLS
 * or pretend a session setting enforces isolation. The pool must use a restricted runtime role.
 * Never perform provider/model/stream I/O in the callback. Unexpected callback errors retain their
 * identity after rollback. Uncertain COMMIT never retries; reconcile by the owner's logical key.
 */
export async function withTenantTransaction<T>(
  pool: Pick<Pool, 'connect'>,
  tenant: TenantContext,
  options: TransactionOptions,
  work: (client: PoolClient, tenant: TenantContext) => Promise<T>
): Promise<TransactionResult<T>> {
  validateOptions(tenant, options);
  const attempts = options.databaseOnlyRetry?.maxAttempts ?? 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let client: PoolClient | undefined;
    let stage: TransactionStage = 'connect';
    let discard = false;
    let failure: TransactionFailure | undefined;
    try {
      client = await pool.connect();
      stage = 'begin';
      await client.query(`BEGIN ISOLATION LEVEL ${options.isolation ?? 'read committed'}`);
      stage = 'configure';
      await client.query(
        "SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true), set_config('idle_in_transaction_session_timeout', $3, true)",
        [`${options.statementTimeoutMs}ms`, `${options.lockTimeoutMs}ms`, `${options.idleTimeoutMs}ms`]
      );
      stage = 'work';
      const value = await work(client, Object.freeze({ organizationId: tenant.organizationId }));
      stage = 'commit';
      const committed = await client.query('COMMIT');
      if (committed.command !== 'COMMIT') {
        return {
          ok: false,
          error: {
            code: 'DATABASE_FAILURE',
            message: 'The database rolled back the transaction.',
            retryable: false,
            stage,
          },
        };
      }
      return { ok: true, value };
    } catch (error) {
      failure = classifyTransactionFailure(error, stage);
      discard = failure.code === 'COMMIT_UNCERTAIN' || failure.code === 'DATABASE_UNAVAILABLE';
      if (client && !discard) {
        try {
          await client.query('ROLLBACK');
        } catch {
          discard = true;
        }
      }
      if (stage === 'work' && failure.code === 'DATABASE_FAILURE' && !failure.sqlState) {
        throw error;
      }
    } finally {
      client?.release(discard);
    }
    if (!failure) {
      throw new Error('Missing transaction outcome.');
    }
    if (failure.code !== 'DATABASE_RETRY' || discard || attempt === attempts) {
      return { ok: false, error: failure };
    }
    const base = options.databaseOnlyRetry?.baseDelayMs ?? 1;
    await delay(base * attempt + Math.floor(Math.random() * base));
  }
  throw new Error('Unreachable transaction attempt.');
}
