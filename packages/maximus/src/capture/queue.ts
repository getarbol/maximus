/**
 * The sink that sends each record to a Cloudflare Queue, whose consumer retries a message it fails and moves
 * the one it keeps failing to its dead letter queue, as the consumer's own configuration says; a payload too
 * large for one message goes to a bucket by reference.
 */
import type { CaptureSink } from '../capture.ts';
import { bindingOf, withinLimit } from './pipeline.ts';
import type { PayloadBucket } from './pipeline.ts';

/**
 * The largest `input`, `output` and `failureData` one message carries together, in bytes: a message holds 128
 * KB, and the rest of a record stays well under the remainder.
 */
const MAX_PAYLOAD_BYTES = 96_000;

/** What this sink calls of a queue's producer binding. */
interface QueueProducer {
  send: (message: unknown, options: { contentType: 'json' }) => Promise<unknown>;
}
/** What `queue()` takes. */
export interface QueueOptions {
  /**
   * The name of the queue's producer binding. While the env has no such binding, capture records nothing and
   * logs nothing, so a preview or a local run without the queue costs nothing.
   */
  binding: string;
  /**
   * The name of an R2 binding for a payload too large for one message: over 96 KB, it is written to
   * `payloads/<organizationId>/<id>.json` and the record carries `payloadRef` instead. Without it, such a
   * record is a failed delivery.
   */
  blobs?: string;
}

/**
 * Sends each record to a queue, the binding `env[binding]`, as one JSON message. The sink sends once: the
 * queue keeps a message it accepted and delivers it at least once, and its consumer's `maxRetries` and
 * `deadLetterQueue` retry and keep what the store refuses, deduplicating on the record's id. A send the queue
 * refuses is a failed delivery, logged as one.
 */
export function queue<E>(options: QueueOptions): CaptureSink<E> {
  const { binding, blobs } = options;
  if (typeof binding !== 'string' || !binding) {
    throw new TypeError('queue() takes the name of a queue binding.');
  }
  return {
    available: (env) =>
      typeof (bindingOf(env, binding) as Partial<QueueProducer> | undefined)?.send === 'function',
    async send(record, env) {
      const producer = bindingOf(env, binding) as QueueProducer;
      const bucket = blobs === undefined ? undefined : (bindingOf(env, blobs) as PayloadBucket | undefined);
      const carried = await withinLimit(record, bucket, MAX_PAYLOAD_BYTES);
      await producer.send(carried, { contentType: 'json' });
    },
  };
}
