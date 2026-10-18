/**
 * The tasks Worker's bindings.
 */

/** The part of a Workers KV namespace the tasks resource uses. */
export interface TaskStore {
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string) => Promise<void>;
  delete: (key: string) => Promise<void>;
  list: (options: { prefix: string; limit: number }) => Promise<{ keys: { name: string }[] }>;
}

/** The bindings declared in cloudflare.config.ts, plus the local-only development token. */
export interface Env {
  TASKS: TaskStore;
  DEVELOPMENT_TOKEN?: string;
}
