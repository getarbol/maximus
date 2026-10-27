/**
 * Workers KV for tests: a Map behind the part of KVNamespace the tasks use. Each call answers a new, empty
 * namespace.
 */
export function testNamespace(): KVNamespace {
  const values = new Map<string, string>();
  const namespace = {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
    list: async ({ prefix, limit = 1000 }: KVNamespaceListOptions = {}) => ({
      keys: [...values.keys()]
        .filter((key) => key.startsWith(prefix ?? ''))
        .toSorted()
        .slice(0, limit)
        .map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    }),
  };
  // The tasks use get, put, delete and list alone: what KVNamespace declares besides goes unused.
  return namespace as unknown as KVNamespace;
}
