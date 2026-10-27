/**
 * The type a schema decodes to: TypeBox's `StaticDecode` where a native transform needs it, `Static`
 * everywhere else.
 */
import type {
  Kind,
  TransformKind,
  Static,
  StaticDecode as TypeBoxStaticDecode,
  TArray,
  TObject,
  TRecord,
  TSchema,
  TTuple,
  TUnion,
} from '@sinclair/typebox';

/** Opaque owner codecs already carry their decoded static type; only native transforms need traversal. */
type HasNativeTransform<S extends TSchema> = typeof TransformKind extends keyof S
  ? true
  : string extends S[typeof Kind]
    ? false
    : S extends TObject<infer P>
      ? true extends { [K in keyof P]: HasNativeTransform<P[K]> }[keyof P]
        ? true
        : false
      : S extends TArray<infer I>
        ? HasNativeTransform<I>
        : S extends TUnion<infer U> | TTuple<infer U>
          ? HasNativeTransform<U[number]>
          : S extends TRecord<TSchema, infer V>
            ? HasNativeTransform<V>
            : false;

/**
 * A schema's decoded value. TypeBox's deep decoder can recurse indefinitely through opaque owner
 * codecs; a schema without native transforms already has exactly its decoded `Static` type.
 */
export type StaticDecode<S extends TSchema> =
  true extends HasNativeTransform<S> ? TypeBoxStaticDecode<S> : Static<S>;
