# Postgres transactions

`@arbol-ai/maximus/postgres` runs short tenant-scoped transactions with `pg`. It depends on nothing
else in Maximus, Cloudflare, Drizzle or a product schema. `pg` is an optional peer dependency: add it
to your project (`bun add pg`) to use this entry. It accepts a pool you configure explicitly and never
reads a connection URL from the environment.

```ts
import { withTenantTransaction } from '@arbol-ai/maximus/postgres';

const result = await withTenantTransaction(
  pool,
  verifiedTenant,
  {
    statementTimeoutMs: 5000,
    lockTimeoutMs: 1000,
    idleTimeoutMs: 5000,
  },
  async (client, tenant) => {
    // Every repository must constrain org_id; the helper cannot enforce arbitrary SQL.
    return (
      await client.query('SELECT id FROM contact WHERE org_id=$1 AND id=$2', [
        tenant.organizationId,
        selectedContactId,
      ])
    ).rows;
  }
);
```

## What it guarantees

- One checked-out client owns `BEGIN`, the time budgets, your SQL, `COMMIT` or `ROLLBACK`, and its
  release. The trusted tenant is copied and frozen for the callback.
- There is deliberately **no row-level security and no tenant session setting**: owner predicates,
  composite keys and tested repositories enforce isolation. Raw runtime credentials can read several
  tenants; this API does not claim otherwise. Runtime roles must not own schemas or tables, or run
  DDL.
- Network, model and provider calls and streaming do not belong in the callback; keep transactions
  short, especially behind a pooler such as Hyperdrive.

## Failures and retries

`classifyTransactionFailure` turns an error into a failure the caller can act on, without server
details or query text:

- Serialization and deadlock errors (SQLSTATE) are retried only with an explicit
  `databaseOnlyRetry`, at most five attempts.
- A transport error or an unknown `COMMIT` outcome answers `COMMIT_UNCERTAIN`, never retryable:
  reconcile by the owner's stable logical key, and never replay a provider action blindly.
- A broken or uncertain client is discarded. An unexpected callback error keeps its identity after
  cleanup.

## Testing it

From the repository root, `bun run test` covers the unit behavior. `bun run test:integration` starts
and removes a disposable Docker container from the **already installed** `postgres:18.6-trixie`
image, on tmpfs and a random loopback port; it accepts no database URL from the environment and never
downloads an image. It covers hash partitions, explicit tenant queries on reused connections,
composite foreign keys, DDL refusal, atomic intent rollback, concurrent claims and revision
compare-and-set. Those are framework boundary fixtures: product schemas need their own tests, and
Hyperdrive and hosted Postgres are separate gates.

Sources: [node-postgres transactions](https://node-postgres.com/features/transactions),
[Postgres SQLSTATE](https://www.postgresql.org/docs/current/errcodes-appendix.html).
