# Postgres transactions

`@arbol-ai/maximus/postgres` runs short, tenant-scoped Postgres transactions with `pg`: one checked-out
client, time budgets, an isolation level, opt-in retries for work that touches only the database, and
failures a route can answer. Read this guide when a service keeps its data in Postgres.

## Install `pg`

`pg` is an optional peer of `@arbol-ai/maximus`: add it, and its types, to the project that uses this entry.

```sh
bun add pg
bun add -d @types/pg
```

Nothing else in Maximus loads `pg`, and the entry imports nothing from the rest of Maximus. It runs in Node
and in a Worker with `nodejs_compat`, which `maximus()` always enables. It takes the pool you configure and
never reads a connection string from the environment.

## Key every table by its organization

The entry installs no row-level security and sets no tenant in the session. The organization reaches your
SQL as a parameter, and your schema and your queries keep each organization's rows apart:

```sql
CREATE TABLE notes (
  organization_id text NOT NULL,
  note_id uuid NOT NULL,
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, note_id)
);

CREATE TABLE note_links (
  organization_id text NOT NULL,
  note_id uuid NOT NULL,
  linked_note_id uuid NOT NULL,
  PRIMARY KEY (organization_id, note_id, linked_note_id),
  FOREIGN KEY (organization_id, note_id) REFERENCES notes (organization_id, note_id),
  FOREIGN KEY (organization_id, linked_note_id) REFERENCES notes (organization_id, note_id)
);
```

- Every primary key, unique key and index leads with `organization_id`.
- Every foreign key includes it, so a row can reference only rows of its own organization: a link from one
  organization's note to another's fails its foreign key.
- Every statement filters by the organization it is given. The entry cannot read your SQL, so this rule
  belongs to your repositories and their tests.

Tenant predicates and composite keys are the product's schema, decided in its repository with the queries
that rely on them.

## Run a transaction

`withTenantTransaction(pool, tenant, options, work)` checks out one client, runs `work` inside one
transaction and answers a result. The tenant is the verified organization: in a route, the principal's
`organizationId`, which `context.ts` passes to the store.

```ts
// src/notes.ts
import { t, UuidSchema } from '@arbol-ai/maximus';
import type { Static } from '@arbol-ai/maximus';
import { withTenantTransaction } from '@arbol-ai/maximus/postgres';
import { readSchema } from '@arbol-ai/maximus/schemas';
import type { Pool } from 'pg';

/** A note, as it is stored and answered. */
export const NoteSchema = t.Object(
  {
    noteId: UuidSchema,
    text: t.String({ minLength: 1, maxLength: 2000 }),
    createdAt: t.String({ format: 'date-time' }),
  },
  { $id: 'Note', additionalProperties: false }
);
export type Note = Static<typeof NoteSchema>;

/** A row of the notes table. */
interface NoteRow {
  note_id: string;
  text: string;
  created_at: Date;
}

/** Each transaction's time budgets, in milliseconds. */
const BUDGETS = { statementTimeoutMs: 5000, lockTimeoutMs: 1000, idleTimeoutMs: 5000 };

/** A row as the note it stores, checked against the note's schema. */
function note(row: NoteRow): Note {
  return readSchema(NoteSchema, {
    noteId: row.note_id,
    text: row.text,
    createdAt: row.created_at.toISOString(),
  });
}

/** The notes of one organization in Postgres: every statement filters by the organization. */
export function noteStore(pool: Pick<Pool, 'connect'>, organizationId: string) {
  const tenant = { organizationId };
  return {
    /** The note, or undefined when the organization has none with this id. */
    get: (noteId: string) =>
      withTenantTransaction(pool, tenant, BUDGETS, async (client, { organizationId: owner }) => {
        const { rows } = await client.query<NoteRow>(
          'SELECT note_id, text, created_at FROM notes WHERE organization_id = $1 AND note_id = $2',
          [owner, noteId]
        );
        return rows[0] === undefined ? undefined : note(rows[0]);
      }),
    /** Stores a new note under the id the caller chose, and answers it. */
    create: (noteId: string, text: string) =>
      withTenantTransaction(pool, tenant, BUDGETS, async (client, { organizationId: owner }) => {
        const { rows } = await client.query<NoteRow>(
          'INSERT INTO notes (organization_id, note_id, text) VALUES ($1, $2, $3) RETURNING note_id, text, created_at',
          [owner, noteId, text]
        );
        const [row] = rows;
        if (!row) {
          throw new TypeError('The insert answered no row.');
        }
        return note(row);
      }),
  };
}
```

`work` receives the client and a frozen copy of the tenant. A row read back goes through `readSchema`, as
any value from storage does (see [Schemas and validation](schemas-and-validation.md)).

The result is `{ ok: true, value }`, where `value` is what `work` returned, or `{ ok: false, error }` with a
[failure](#failures).

## Options

| Option               | Required | Accepts                                                           | Sets                                                                                                            |
| -------------------- | -------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `statementTimeoutMs` | Yes      | 1 to 60000                                                        | `statement_timeout`: how long one statement may run.                                                            |
| `lockTimeoutMs`      | Yes      | 1 to 60000                                                        | `lock_timeout`: how long a statement may wait for a lock.                                                       |
| `idleTimeoutMs`      | Yes      | 1 to 60000                                                        | `idle_in_transaction_session_timeout`: how long the transaction may wait idle before Postgres ends its session. |
| `isolation`          | No       | `read committed` (the default), `repeatable read`, `serializable` | The isolation level `BEGIN` states.                                                                             |
| `databaseOnlyRetry`  | No       | `{ maxAttempts: 1 to 5, baseDelayMs: 1 to 1000 }`                 | Retries of a transaction the database aborted; see [Retries](#retries). Without it, one attempt.                |

The three budgets are whole milliseconds, set for the transaction alone: a client that goes back to the pool
keeps none of them for the next tenant's transaction.

The call refuses, with a `TypeError` and before it checks out a client:

| Refused                                                                                                           | Message                                                              |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| An organization id that is not a string of 1 to 128 letters, digits, `_` and `-`, starting with a letter or digit | `A trusted organization identifier is required.`                     |
| A time budget that is not an integer from 1 to 60000                                                              | `Transaction time budgets must be between 1 and 60000 milliseconds.` |
| Another isolation level                                                                                           | `Unsupported isolation level.`                                       |
| Attempts outside 1 to 5, or a delay outside 1 to 1000 milliseconds                                                | `Database retries require bounded attempts and delay.`               |

## What one call does

1. Checks out one client from the pool.
2. Begins the transaction at its isolation level: `BEGIN ISOLATION LEVEL read committed` by default.
3. Sets the three time budgets for this transaction.
4. Runs `work` with that client.
5. Commits, and releases the client to the pool.

When a step fails, the call rolls the transaction back and releases the client. A client whose state is
unknown, after a commit whose outcome is uncertain, a connection that failed or a rollback that failed, is
destroyed instead of going back to the pool.

An error thrown during `work` that the server did not send, a `TypeError` in your code for instance, is thrown
again as it is, once the transaction is rolled back and the client released. In a route, it becomes
`INTERNAL_ERROR`, reported as `maximus.unexpected`.

When `work` catches a failed statement and returns anyway, Postgres has already aborted the transaction and
answers the `COMMIT` with a rollback. The result is then a `DATABASE_FAILURE` at the `commit` stage, whose
message is `The database rolled back the transaction.`, and nothing was written.

## Failures

A failure is `{ code, message, retryable, stage, sqlState }`:

| Code                   | When                                                                                                                                                                           | `retryable` |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| `DATABASE_UNAVAILABLE` | The pool gave no client, or the server reported a connection failure (SQLSTATE class `08`), too many connections (`53300`) or that it cannot accept connections yet (`57P03`). | `true`      |
| `DATABASE_RETRY`       | The database aborted the transaction: a serialization failure (`40001`) or a deadlock (`40P01`).                                                                               | `true`      |
| `DATABASE_CONFLICT`    | A constraint refused the change: unique (`23505`), foreign key (`23503`), check (`23514`) or exclusion (`23P01`).                                                              | `false`     |
| `COMMIT_UNCERTAIN`     | The commit's outcome is unknown: the connection broke during it, or the server answered a connection failure (class `08`), an operator intervention (class `57`) or `40003`.   | `false`     |
| `DATABASE_FAILURE`     | Any other failure of the database, or a commit Postgres answered with a rollback.                                                                                              | `false`     |

- `stage` says where the transaction was: `connect`, `begin`, `configure`, `work` or `commit`.
- `sqlState` is the five-character SQLSTATE the server reported, when it reported one. An uncertain commit
  has none.

Each code has a fixed `message`:

| Code                   | `message`                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_UNAVAILABLE` | `The database is unavailable.`                                                                                             |
| `DATABASE_RETRY`       | `The database transaction was aborted.`                                                                                    |
| `DATABASE_CONFLICT`    | `The database constraint rejected the change.`                                                                             |
| `COMMIT_UNCERTAIN`     | `Commit outcome must be reconciled before replay.`                                                                         |
| `DATABASE_FAILURE`     | `The database transaction failed.`, or `The database rolled back the transaction.` after a commit answered with a rollback |

A failure never carries the server's message, its detail or its hint, nor the query: a refused unique key's
detail names the key's values, and a refused value's message quotes the value. Only an error the server sent
establishes a SQLSTATE; the text of any other error is never read.

`retryable` tells the caller whether the same request may succeed later. It does not make the call retry:
only [Retries](#retries) do that.

## Retries

Retries are off unless you pass `databaseOnlyRetry`. With it, a `DATABASE_RETRY` runs the whole transaction
again, `work` included, on a freshly checked-out client, up to `maxAttempts` attempts in all. Between two
attempts the call waits `baseDelayMs` times the attempt's number, plus a random share of `baseDelayMs`.

A count followed by a write is the usual case: under `serializable`, Postgres aborts one of two transactions
that would together break the rule, and the retry runs it again against the other's result.

```ts
// src/quota.ts
import { withTenantTransaction } from '@arbol-ai/maximus/postgres';
import type { Pool } from 'pg';

/**
 * Stores a new note unless the organization already holds `limit` notes, and answers whether it did. Two
 * writers that count at once cannot both pass the limit: under `serializable`, Postgres aborts one of them,
 * which runs again and counts the other's note.
 */
export function createWithinQuota(
  pool: Pick<Pool, 'connect'>,
  organizationId: string,
  note: { noteId: string; text: string },
  limit: number
) {
  return withTenantTransaction(
    pool,
    { organizationId },
    {
      statementTimeoutMs: 5000,
      lockTimeoutMs: 1000,
      idleTimeoutMs: 5000,
      isolation: 'serializable',
      databaseOnlyRetry: { maxAttempts: 3, baseDelayMs: 20 },
    },
    async (client, { organizationId: owner }) => {
      const { rows } = await client.query<{ total: number }>(
        'SELECT count(*)::int AS total FROM notes WHERE organization_id = $1',
        [owner]
      );
      if ((rows[0]?.total ?? 0) >= limit) {
        return false;
      }
      await client.query('INSERT INTO notes (organization_id, note_id, text) VALUES ($1, $2, $3)', [
        owner,
        note.noteId,
        note.text,
      ]);
      return true;
    }
  );
}
```

Nothing else is retried: not `DATABASE_UNAVAILABLE`, not a conflict, not an aborted transaction whose client
had to be destroyed, and never an uncertain commit.

Opt in only when `work` touches the database alone. A retry runs `work` again, so a call it makes to a
provider, a model, a queue or another service would happen twice. Keep such calls, and streaming, outside
the transaction, which then stays short.

An uncertain commit may have written. Reconcile it by the write's stable key before anything repeats it:
the id the caller chose for a note, for instance, lets a repeated request find the note the first one wrote.
Until then the caller learns `OUTCOME_UNKNOWN`, as the next section shows.

## Answer the caller

A route translates a transaction's failure into one of the service's failures. The database being out of
reach is `UPSTREAM_UNAVAILABLE`, which a caller may retry; an uncertain commit is `OUTCOME_UNKNOWN`, which it
must reconcile first; anything unexpected is the service's own error:

```ts
// src/database.ts
import type { TransactionFailure } from '@arbol-ai/maximus/postgres';

/**
 * The standard failure a route answers for a transaction that did not complete: the database is out of
 * reach or kept aborting it, or a write's outcome is unknown. Any other failure is the service's own error.
 */
export function standardFailure(failure: TransactionFailure): 'UPSTREAM_UNAVAILABLE' | 'OUTCOME_UNKNOWN' {
  if (failure.code === 'DATABASE_UNAVAILABLE' || failure.code === 'DATABASE_RETRY') {
    return 'UPSTREAM_UNAVAILABLE';
  }
  if (failure.code === 'COMMIT_UNCERTAIN') {
    return 'OUTCOME_UNKNOWN';
  }
  throw new TypeError(`The notes transaction failed at its ${failure.stage} stage.`);
}
```

A conflict the caller can fix becomes a failure of the service's own catalog, here `NOTE_EXISTS` from
`errors.ts`:

```ts
// routes/v1/notes.post.ts
import { defineHandler, t, UuidSchema } from '@arbol-ai/maximus';

import { standardFailure } from '../../src/database.ts';
import { NoteSchema } from '../../src/notes.ts';

/** POST /api/v1/notes: a new note under the id its caller chose, so a repeated request finds it. */
export default defineHandler(
  async ({ input, notes, fail }) => {
    const created = await notes.create(input.noteId, input.text);
    if (created.ok) {
      return created.value;
    }
    return created.error.code === 'DATABASE_CONFLICT'
      ? fail('NOTE_EXISTS')
      : fail(standardFailure(created.error));
  },
  {
    description: 'Write a note for the organization, under an id the caller chooses.',
    input: { noteId: UuidSchema, text: t.String({ minLength: 1, maxLength: 2000 }) },
    output: NoteSchema,
    failures: ['NOTE_EXISTS'],
    http: { successStatus: 201 },
  }
);
```

The standard failures need no declaration; [Errors and results](errors-and-results.md) covers the catalog,
and [Standard failures](../reference/standard-failures.md) lists `UPSTREAM_UNAVAILABLE` and
`OUTCOME_UNKNOWN`.

## Give the Worker a restricted role

Without row-level security, the credentials the pool connects with can read every organization's rows, and
only your queries keep them apart. Connect as a role that owns no schema and no table, and that may read and
write the tables the service uses and nothing else, so it cannot change the schema; run migrations as
another role.

## Test the repositories

A fake pool, an object whose `connect()` answers a client whose `query` your test controls, exercises how a
store and its routes handle each failure. The isolation of your queries needs a real Postgres: run the
repositories against a disposable database, as the runtime role, and check that one organization never reads
or changes another's rows, that a composite foreign key refuses a reference across organizations, and that
the role cannot run DDL.

Maximus tests the entry the same way: `bun run test:integration`, in the Maximus repository, starts a
disposable container from the `postgres:18.6-trixie` image already installed in Docker, on tmpfs and a
loopback port, and never downloads an image or reads a database URL from the environment. Those tests prove
the entry's behavior, not a product's schema, which needs its own.
