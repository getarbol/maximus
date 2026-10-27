/**
 * `cloudflare:workers` for tests in Node, which `maximus()` resolves under Vitest: the base classes of
 * entrypoints and Durable Objects keep the context and the bindings they are constructed with, and `tracing`
 * has no active span until a test installs `getActiveSpan`. Whatever else a test needs of the platform, it
 * passes in that context.
 */
/* oxlint-disable max-classes-per-file -- The module it stands in for exports each of these classes. */

/** A span, as a test installs one to read back the attributes set on it. */
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

/** The base of objects passed by reference over RPC: a marker, with no members of its own to stand in for. */
// oxlint-disable-next-line typescript/no-extraneous-class -- code extends it; the runtime's has no public members.
export class RpcTarget {}

/** Native tracing: no active span until a test installs `getActiveSpan`. */
export const tracing: { getActiveSpan?: () => RecordedSpan | undefined } = {};
