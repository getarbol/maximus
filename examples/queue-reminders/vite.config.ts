/**
 * The only configuration: the reminders service, its Worker, the queue that delivers reminders and the KV
 * namespace that keeps them. The first deployment creates the queue, its dead letter queue and the namespace.
 */
import { maximus } from '@arbol-ai/vite-plugin';
import { bindings, triggers } from 'cf/config';
import { defineConfig } from 'vite-plus';

/** The queue, which queues/maximus-example-reminders.ts consumes: a queue module is named after its queue. */
const QUEUE = 'maximus-example-reminders';

export default defineConfig({
  plugins: [
    maximus({
      name: 'example-queue-reminders',
      namespace: 'reminders',
      title: 'Reminders',
      // The Worker's workers.dev URL in the account it deploys to.
      origin: `https://example-queue-reminders.${process.env.WORKERS_SUBDOMAIN ?? 'example'}.workers.dev`,
      tokens: { issuer: 'https://auth.example.com/' },
      compatibilityDate: '2026-10-26',
      env: {
        // src/reminders.ts types the messages the Worker sends.
        REMINDERS: bindings.queue({ name: QUEUE }),
        REMINDER_STATE: bindings.kv(),
      },
      // The queue module subscribes the Worker by itself; this trigger states how it consumes: batches of ten,
      // and five retries, six deliveries in all, before a message moves to the dead letter queue, which keeps
      // it for inspection.
      triggers: [
        triggers.queue({ name: QUEUE, maxBatchSize: 10, maxRetries: 5, deadLetterQueue: `${QUEUE}-dead` }),
      ],
    }),
  ],
});
