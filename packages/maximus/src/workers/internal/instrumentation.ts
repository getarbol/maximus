/**
 * Runs the methods of a Worker's own entrypoints and Durable Objects inside the application's diagnostics.
 */
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';

import { withTelemetry } from '../../telemetry.ts';
import type { TelemetryConfig } from '../../telemetry.ts';

/**
 * A subclass of `implementation` whose every method, its own and those it inherits up to the Workers
 * base class `runtime`, runs inside the application's diagnostics for the instance's `env`.
 */
function instrumentMethods<C, E, D extends new (context: C, env: E) => object>(
  implementation: D,
  runtime: { prototype: object },
  telemetry: TelemetryConfig<E> | undefined
): D {
  const Base: new (context: C, env: E) => object = implementation;
  const environments = new WeakMap<object, E>();
  class Observed extends Base {
    constructor(context: C, env: E) {
      super(context, env);
      environments.set(this, env);
    }
  }
  let { prototype } = implementation;
  const methods = new Set<string>();
  while (prototype && prototype !== runtime.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const method = Object.getOwnPropertyDescriptor(prototype, name)?.value;
      if (name === 'constructor' || methods.has(name) || typeof method !== 'function') {
        continue;
      }
      methods.add(name);
      // Writable as a class method is, so the class may rebind it to an instance as it is constructed.
      Object.defineProperty(Observed.prototype, name, {
        configurable: true,
        writable: true,
        value(this: object, ...args: unknown[]) {
          return withTelemetry(telemetry, environments.get(this), () => Reflect.apply(method, this, args));
        },
      });
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return Observed as D;
}

/** A named entrypoint whose RPC methods run inside the application's diagnostics. */
export function instrumentService<E, D extends new (ctx: ExecutionContext, env: E) => WorkerEntrypoint<E>>(
  implementation: D,
  telemetry: TelemetryConfig<E> | undefined
): D {
  return instrumentMethods<ExecutionContext, E, D>(implementation, WorkerEntrypoint, telemetry);
}

/** A Durable Object whose methods run inside the application's diagnostics. */
export function instrumentDurableObject<
  E,
  D extends new (state: DurableObject['ctx'], env: E) => DurableObject<E>,
>(implementation: D, telemetry: TelemetryConfig<E> | undefined): D {
  return instrumentMethods<DurableObject['ctx'], E, D>(implementation, DurableObject, telemetry);
}
