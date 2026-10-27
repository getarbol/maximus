/**
 * Workers KV, a queue and its batches for tests, behind the part of their APIs the reminders use. Each call
 * answers a new, empty one.
 */

/** A KV namespace that keeps each value with its metadata, and lists them two keys a page. */
export function testNamespace(): KVNamespace {
  const entries = new Map<string, { value: string; metadata: unknown }>();
  const namespace = {
    get: async (key: string) => entries.get(key)?.value ?? null,
    put: async (key: string, value: string, options: KVNamespacePutOptions = {}) => {
      entries.set(key, { value, metadata: options.metadata ?? null });
    },
    list: async ({ prefix, cursor }: KVNamespaceListOptions = {}) => {
      const names = [...entries.keys()].filter((key) => key.startsWith(prefix ?? '')).toSorted();
      const start = Number(cursor ?? 0);
      const keys = names
        .slice(start, start + 2)
        .map((name) => ({ name, metadata: entries.get(name)?.metadata }));
      return start + 2 < names.length
        ? { keys, list_complete: false, cursor: String(start + 2), cacheStatus: null }
        : { keys, list_complete: true, cacheStatus: null };
    },
  };
  // The reminders use get, put and list alone: what KVNamespace declares besides goes unused.
  return namespace as unknown as KVNamespace;
}

/** A queue that records each message the Worker sends, with its options. */
export function testQueue<Body>() {
  const sent: { body: Body; delaySeconds?: number }[] = [];
  const queue = {
    sent,
    send: async (body: Body, options: QueueSendOptions = {}) => {
      sent.push({ body, ...options });
    },
    sendBatch: async (messages: Iterable<MessageSendRequest<Body>>) => {
      sent.push(...[...messages].map(({ body }) => ({ body })));
    },
  };
  // The reminders use send and sendBatch alone.
  return queue as unknown as Queue<Body> & { sent: typeof sent };
}

/** What became of a message: acknowledged, retried after a delay, or neither. */
export type Outcome = 'ack' | { retryAfter: number } | undefined;

/** A batch of the reminders queue, each body its attempt; `outcomes` tells what the consumer did with each. */
export function testBatch(bodies: unknown[], attempts = 1) {
  const outcomes: Outcome[] = bodies.map(() => undefined);
  const messages = bodies.map((body, index) => ({
    id: `message-${index}`,
    timestamp: new Date(),
    body,
    attempts,
    ack() {
      outcomes[index] = 'ack';
    },
    retry(options: QueueRetryOptions = {}) {
      outcomes[index] = { retryAfter: options.delaySeconds ?? 0 };
    },
  }));
  const batch = { queue: 'maximus-example-reminders', messages, ackAll() {}, retryAll() {} };
  // The consumer reads messages and settles each one alone.
  return { batch: batch as unknown as MessageBatch, outcomes };
}

/** The execution context the platform passes; the reminders' handlers never use it. */
export const context = {} as ExecutionContext;
