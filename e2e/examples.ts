/**
 * The example Workers the end-to-end suites call: where each one lives, its Worker's name, and the port
 * `vp dev` serves it on in a local run. The global setup starts them from this table, and the suites reach
 * them through what it provides.
 */

/** An example's Worker, as a suite reaches it. */
export interface Service {
  /** The origin it answers at: `vp dev`'s, or its workers.dev URL. */
  url: string;
  /** The development token `vp dev` accepts from localhost; absent against a deployed Worker. */
  token?: string;
  /** Whether it is the Worker deployed to Cloudflare, built for production. */
  deployed?: boolean;
}

/** An example: its directory under examples/, its Worker's name, and the port `vp dev` serves it on here. */
export interface Example {
  directory: string;
  worker: string;
  port: number;
  /** Whether `vp dev` reaches the account's own service for a binding, and so needs Cloudflare credentials. */
  remote?: boolean;
}

/** Every example Worker the suites call. */
export const EXAMPLES = {
  tasks: { directory: 'tasks', worker: 'example-tasks', port: 5301 },
  notes: { directory: 'd1-notes', worker: 'example-d1-notes', port: 5302 },
  pricing: { directory: 'worker-rpc/pricing', worker: 'example-pricing', port: 5303 },
  orders: { directory: 'worker-rpc/orders', worker: 'example-orders', port: 5304 },
  reminders: { directory: 'queue-reminders', worker: 'example-queue-reminders', port: 5305 },
  documents: { directory: 'r2-documents', worker: 'example-r2-documents', port: 5306 },
  appointments: { directory: 'do-appointments', worker: 'example-do-appointments', port: 5307 },
  pages: { directory: 'browser-pages', worker: 'example-browser-pages', port: 5308, remote: true },
} as const satisfies Record<string, Example>;

/** An example's key in `EXAMPLES`. */
export type ExampleName = keyof typeof EXAMPLES;
