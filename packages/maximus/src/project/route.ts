/** A named method export delegates to the existing builder when generation supplies its path and verb. */
import type { TSchema } from '@sinclair/typebox';

import type { ApplicationBuilder, KnownOperationFields } from '../builder.ts';
import type { Exposure, OperationContext, OperationDefinition, OperationHandler } from '../manifest.ts';

type RouteExposure = Omit<Exposure, 'http'> & {
  http?: Omit<NonNullable<Exposure['http']>, 'method' | 'path'>;
};
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
    definition: OperationDefinition<I, O, X> & KnownRouteFields<X>,
    execute: OperationHandler<C, I, O, X>
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
      const bound = { ...definition, http: { ...definition.http, path, method } } as OperationDefinition<
        I,
        O,
        Bound
      > &
        KnownOperationFields<Bound>;
      return base.operation<N, I, O, Bound>(name, bound, (context, input) =>
        // Binding a path and verb preserves the byte-body declaration; TypeScript cannot reduce the
        // generic conditional across that object spread. Native admission still owns body decoding.
        execute(context as OperationContext<C, X>, input)
      );
    };
  };
}
