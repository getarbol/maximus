/** A named method export delegates to the existing builder when generation supplies its path and verb. */
import type { Static, TSchema } from '@sinclair/typebox';

import type { BinaryBody } from '../binary.ts';
import type { ApplicationBuilder, OperationFields, KnownOperationFields } from '../builder.ts';
import type { Failure } from '../errors.ts';
import type { Exposure } from '../manifest.ts';
import type { Result } from '../result.ts';
import type { StaticDecode } from '../schema-types.ts';

type RouteExposure = Omit<Exposure, 'http'> & {
  http?: Omit<NonNullable<Exposure['http']>, 'method' | 'path'>;
};
type Definition<I extends TSchema, O extends TSchema, X extends RouteExposure> = X & OperationFields<I, O>;
type KnownRouteFields<X> = KnownOperationFields<X> &
  (X extends { http: infer H }
    ? { http: H & Readonly<Record<Exclude<keyof H, keyof NonNullable<RouteExposure['http']>>, never>> }
    : unknown);

/** Bind named method declarations to one shared, fully inferred application context. */
export function createRoute<E, C>(base: ApplicationBuilder<E, C, Record<never, never>>) {
  return function defineRoute<
    const N extends string,
    I extends TSchema,
    O extends TSchema,
    const X extends RouteExposure,
  >(
    name: N,
    definition: Definition<I, O, X> & KnownRouteFields<X>,
    execute: (
      context: C & (X extends { http: { body: 'bytes' } } ? { body: BinaryBody } : object),
      input: StaticDecode<I>
    ) => Promise<Result<Static<O>, Failure>>
  ) {
    if (definition.http && ('method' in definition.http || 'path' in definition.http)) {
      throw new TypeError('The route filename and method export own http.path and http.method.');
    }
    return <const P extends string, const M extends NonNullable<Exposure['http']>['method']>(
      path: P,
      method: M
    ) => {
      type Bound = X & { http: (X extends { http: infer H } ? H : object) & { path: P; method: M } };
      // Only the two filesystem-owned fields are added. Keep the caller's literal exposure and schemas.
      const bound = { ...definition, http: { ...definition.http, path, method } } as Definition<I, O, Bound> &
        KnownOperationFields<Bound>;
      return base.operation<N, I, O, Bound>(name, bound, (context, input) =>
        // Binding a path and verb preserves the byte-body declaration; TypeScript cannot reduce the
        // generic conditional across that object spread. Native admission still owns body decoding.
        execute(context as C & (X extends { http: { body: 'bytes' } } ? { body: BinaryBody } : object), input)
      );
    };
  };
}
