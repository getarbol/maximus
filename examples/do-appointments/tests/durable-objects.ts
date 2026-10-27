/**
 * A Durable Object namespace for tests: each name gets one instance, constructed with a state whose SQL
 * storage is Node's SQLite in memory, and called directly, as Cloudflare delivers one call at a time.
 */
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';

/** SQL storage over a new in-memory database: `exec` answers the rows a query reads, or how many it wrote. */
function sqlStorage() {
  const database = new DatabaseSync(':memory:');
  return {
    exec(query: string, ...bindings: SQLInputValue[]) {
      const statement = database.prepare(query);
      if (statement.columns().length > 0) {
        const rows = statement.all(...bindings);
        return { toArray: () => rows, rowsWritten: 0 };
      }
      const { changes } = statement.run(...bindings);
      return { toArray: () => [], rowsWritten: Number(changes) };
    },
  };
}

/** A namespace whose instances `create` constructs from their state, and the names it was asked for. */
export function testNamespace<T>(create: (state: DurableObjectState) => T) {
  const instances = new Map<string, T>();
  return {
    getByName(name: string): T {
      const existing = instances.get(name);
      if (existing) {
        return existing;
      }
      // The classes use storage.sql alone: what DurableObjectState declares besides goes unused.
      const instance = create({ storage: { sql: sqlStorage() } } as unknown as DurableObjectState);
      instances.set(name, instance);
      return instance;
    },
    /** The name of every instance the Worker reached. */
    names: () => [...instances.keys()],
  };
}
