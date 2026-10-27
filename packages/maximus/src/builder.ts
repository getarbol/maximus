/**
 * The fluent builder. `maximus()` starts an application, `.derive()` and `.use()` prepare each call,
 * `.operation()` declares operations, `.mount()` composes resource modules that share one base, and
 * `.build()` checks the result.
 */
import type { TSchema } from '@sinclair/typebox';

import { defineApp } from './define-app.ts';
import type { Failure } from './errors.ts';
import { composeOperations } from './manifest.ts';
import type {
  AppManifest,
  Invocation,
  OperationDefinition,
  OperationHandler,
  OperationShape,
  OperationMiddleware,
  Exposure,
} from './manifest.ts';
import { ok } from './result.ts';
import type { Result } from './result.ts';

export type { OperationFields } from './manifest.ts';

/**
 * What `maximus()` takes: the application without its operations, context and middleware, which the builder
 * adds.
 */
export type ApplicationConfiguration<E> = Omit<
  AppManifest<E, Invocation<E>, Record<never, never>>,
  'context' | 'operations' | 'middleware'
>;
/**
 * Refuses, in the type, a module that declares an operation the builder already has: `.mount()` would throw
 * on it. The property names the operations the two declare.
 */
type DistinctOperations<Ops, M> = [Extract<keyof M, keyof Ops>] extends [never]
  ? unknown
  : { readonly 'Operations declared twice': Extract<keyof M, keyof Ops> };
/** Refuses a definition field no operation has, such as a misspelled one, which would otherwise do nothing. */
export type KnownOperationFields<X> = Readonly<Record<Exclude<keyof X, keyof OperationShape>, never>>;
/**
 * An application under construction, as `maximus()` starts it. Every method returns a new builder and leaves
 * this one unchanged, so resource modules built from one base share its inferred context without overwriting
 * each other's operations.
 */
export class ApplicationBuilder<E, C, Ops extends Record<string, OperationShape>> {
  /**
   * The application declared so far: its configuration, context preparation, middleware and operations, which
   * `.build()` checks.
   */
  readonly definition: AppManifest<E, C, Ops>;
  private readonly root: object;
  /**
   * Wraps `definition`. `root` identifies the application the builder descends from, and `.mount()` admits
   * only modules of the same one. Start an application with `maximus()` instead.
   */
  constructor(definition: AppManifest<E, C, Ops>, root: object = definition) {
    this.definition = definition;
    this.root = root;
  }
  /**
   * Declares an operation: a camelCase name no other operation uses, its definition (scope, words, effect,
   * schemas and exposure) and its handler, which receives the prepared context and the decoded input and
   * returns a Result. A name declared twice throws a TypeError, `Duplicate operation: <name>`.
   */
  operation<const N extends string, I extends TSchema, O extends TSchema, const X extends Exposure>(
    name: N extends keyof Ops ? never : N,
    definition: OperationDefinition<I, O, X> & KnownOperationFields<X>,
    execute: OperationHandler<C, I, O, X>
  ): ApplicationBuilder<E, C, Ops & Record<N, OperationDefinition<I, O, X> & { execute: typeof execute }>> {
    const operations = composeOperations(this.definition.operations, {
      [name]: {
        ...definition,
        execute,
        pipeline: {
          context: (invocation: Invocation<E>) => this.definition.context({ ...invocation, operation: name }),
          middleware: this.definition.middleware ?? [],
        },
      },
    }) as AppManifest<
      E,
      C,
      Ops & Record<N, OperationDefinition<I, O, X> & { execute: typeof execute }>
    >['operations'];
    return new ApplicationBuilder({ ...this.definition, operations }, this.root) as ApplicationBuilder<
      E,
      C,
      Ops & Record<N, OperationDefinition<I, O, X> & { execute: typeof execute }>
    >;
  }
  /**
   * Adds what `resolve` returns to the context of every operation declared after it. It runs after admission
   * and before the middleware; a failure it returns answers the call. Derive before declaring operations: on
   * a builder that already has one, it throws a TypeError.
   */
  derive<D extends object>(
    resolve: (context: C) => Promise<Result<D, Failure>>
  ): ApplicationBuilder<E, C & D, Ops> {
    if (Object.keys(this.definition.operations).length) {
      throw new TypeError('Derive context before declaring operations.');
    }
    const previous = this.definition.context;
    return new ApplicationBuilder(
      {
        ...this.definition,
        context: async (invocation) => {
          const context = await previous(invocation);
          if (!context.ok) {
            return context;
          }
          const derived = await resolve(context.value);
          return derived.ok ? ok({ ...context.value, ...derived.value }) : derived;
        },
      },
      this.root
    );
  }
  /**
   * Wraps every operation declared after it, once the caller is admitted and the context prepared. The
   * middleware calls `next` at most once.
   */
  use(middleware: OperationMiddleware<C>): ApplicationBuilder<E, C, Ops> {
    return new ApplicationBuilder(
      {
        ...this.definition,
        middleware: [...(this.definition.middleware ?? []), middleware],
      },
      this.root
    );
  }
  /**
   * Adds the operations of a resource module built from the same application; each keeps the context and
   * middleware it was declared with. A module of another application, or one that declares an operation this
   * builder has, throws a TypeError.
   */
  mount<MC, M extends Record<string, OperationShape>>(
    module: ApplicationBuilder<E, MC, M> & DistinctOperations<Ops, M>
  ): ApplicationBuilder<E, C, Ops & M> {
    if (this.root !== module.root) {
      throw new TypeError('Resource groups must derive from the same application.');
    }
    return new ApplicationBuilder<E, C, Ops & M>(
      {
        ...this.definition,
        operations: composeOperations(this.definition.operations, module.definition.operations) as Ops & M,
      },
      this.root
    );
  }
  /**
   * Checks every rule the application must keep and returns it. A refusal is a TypeError whose message names
   * the rule; most of the rules about one operation also name that operation.
   */
  build(): AppManifest<E, C, Ops> {
    return defineApp<E, C>()(this.definition);
  }
}
/**
 * Starts an application: its name, scope namespace, title, version, origin, token policy, error catalog and
 * RPC callers, and its optional limits, rate limit, telemetry and MCP configuration. Chain `.derive()` and
 * `.use()` to prepare each call, `.operation()` to declare operations, `.mount()` to compose resource modules
 * that share this base, then `.build()`.
 */
export function maximus<E>(
  configuration: ApplicationConfiguration<E>
): ApplicationBuilder<E, Invocation<E>, Record<never, never>> {
  return new ApplicationBuilder({
    ...configuration,
    operations: {},
    context: (invocation) => Promise.resolve(ok(invocation)),
  });
}
