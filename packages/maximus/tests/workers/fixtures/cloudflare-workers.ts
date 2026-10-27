/**
 * The parts of `cloudflare:workers` the runtime uses, for unit tests that run it in Node rather than
 * workerd: the entrypoint and Durable Object base classes keep their context and bindings, and `tracing`
 * answers the active span a test installs. Suites that need workerd itself run it through Miniflare.
 */
/* oxlint-disable max-classes-per-file -- The module it stands in for exports both base classes. */

/** A span's attributes, as a test reads them back. */
export interface RecordedSpan {
  setAttributes: (attributes: Record<string, unknown>) => void;
}

/** The base of a Worker's named entrypoints. */
export class WorkerEntrypoint<Env = unknown> {
  protected readonly ctx: unknown;
  protected readonly env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

/** The base of a Worker's Durable Object classes. */
export class DurableObject<Env = unknown> {
  protected readonly ctx: unknown;
  protected readonly env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

/** Native tracing: no active span until a test installs `getActiveSpan`. */
export const tracing: { getActiveSpan?: () => RecordedSpan | undefined } = {};
