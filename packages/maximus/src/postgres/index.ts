/**
 * `@arbol-ai/maximus/postgres`: short tenant-scoped Postgres transactions for Node or Workers with
 * `nodejs_compat`. Needs the optional peer `pg`; nothing else in Maximus loads it.
 */
export { withTenantTransaction } from './transaction.ts';
export type { TenantContext, TransactionOptions, TransactionResult } from './transaction.ts';
export { classifyTransactionFailure } from './failures.ts';
export type { TransactionFailure, TransactionStage } from './failures.ts';
