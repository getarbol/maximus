/**
 * Classifies a Postgres transaction failure by the server's SQLSTATE and the stage it happened in, never
 * by its message.
 */
import { DatabaseError } from 'pg';

/** Where a transaction was when it failed. */
export type TransactionStage = 'connect' | 'begin' | 'configure' | 'work' | 'commit';
/**
 * A classified transaction failure: retryable only when the database says so, and never for a commit whose
 * outcome is unknown.
 */
export interface TransactionFailure {
  /**
   * The stable code callers branch on, such as `DATABASE_RETRY` for a serialization or deadlock abort, or
   * `COMMIT_UNCERTAIN` when the commit's outcome is unknown.
   */
  code:
    | 'DATABASE_CONFLICT'
    | 'DATABASE_RETRY'
    | 'DATABASE_UNAVAILABLE'
    | 'COMMIT_UNCERTAIN'
    | 'DATABASE_FAILURE';
  /** A fixed description of the failure, never the server's own message or the query text. */
  message: string;
  /** A database retry never authorizes replaying an external effect. */
  retryable: boolean;
  /** Where the transaction was when it failed, such as `work` while the callback ran, or `commit`. */
  stage: TransactionStage;
  /**
   * The five-character SQLSTATE the server reported, such as `40001`; absent when the server reported none
   * and for an uncertain commit.
   */
  sqlState?: string;
}

/** Only server ErrorResponse instances establish a SQLSTATE; arbitrary error messages are never classified. */
export function classifyTransactionFailure(error: unknown, stage: TransactionStage): TransactionFailure {
  const sqlState =
    error instanceof DatabaseError && /^[0-9A-Z]{5}$/.test(error.code ?? '') ? error.code : undefined;
  if (
    stage === 'commit' &&
    (!sqlState || sqlState.startsWith('08') || sqlState === '40003' || sqlState.startsWith('57'))
  ) {
    return {
      code: 'COMMIT_UNCERTAIN',
      message: 'Commit outcome must be reconciled before replay.',
      retryable: false,
      stage,
    };
  }
  if (sqlState === '40001' || sqlState === '40P01') {
    return {
      code: 'DATABASE_RETRY',
      message: 'The database transaction was aborted.',
      retryable: true,
      stage,
      sqlState,
    };
  }
  if (sqlState === '23505' || sqlState === '23503' || sqlState === '23514' || sqlState === '23P01') {
    return {
      code: 'DATABASE_CONFLICT',
      message: 'The database constraint rejected the change.',
      retryable: false,
      stage,
      sqlState,
    };
  }
  if (stage === 'connect' || sqlState?.startsWith('08') || sqlState === '53300' || sqlState === '57P03') {
    return {
      code: 'DATABASE_UNAVAILABLE',
      message: 'The database is unavailable.',
      retryable: true,
      stage,
      ...(sqlState ? { sqlState } : {}),
    };
  }
  return {
    code: 'DATABASE_FAILURE',
    message: 'The database transaction failed.',
    retryable: false,
    stage,
    ...(sqlState ? { sqlState } : {}),
  };
}
