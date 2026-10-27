/**
 * A D1 database for tests: Node's SQLite in memory with the example's migrations applied, behind the part of
 * D1's API the notes use. Each call answers a new, empty database.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';

/** The example's migrations, in the order `cf d1 migrations apply` applies them. */
const MIGRATIONS = join(import.meta.dirname, '../migrations');

/** A new in-memory database with every migration applied. */
export function testDatabase(): D1Database {
  const database = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .toSorted()) {
    database.exec(readFileSync(join(MIGRATIONS, file), 'utf-8'));
  }
  /** A statement with the values bound so far. */
  const statement = (sql: string, values: readonly SQLInputValue[] = []) => ({
    bind: (...bound: SQLInputValue[]) => statement(sql, bound),
    first: async () => database.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: database.prepare(sql).all(...values), success: true, meta: {} }),
    run: async () => {
      const { changes } = database.prepare(sql).run(...values);
      return { results: [], success: true, meta: { changes: Number(changes) } };
    },
  });
  // The notes use prepare, bind, first, all and run alone: what D1Database declares besides goes unused.
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}
