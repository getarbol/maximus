/**
 * Owner codecs on TypeBox schemas: defaults, normalizers, transforms, inspections, refinements, pipes and
 * unknown-key stripping. `inputSchema()` compiles them into one input schema, so the wire is checked as
 * declared and the handler receives the decoded value.
 */
import { Type as t, Kind, TransformKind } from '@sinclair/typebox';
import type {
  Static,
  TSchema,
  TObject,
  TProperties,
  TUnsafe,
  TArray,
  TUnion,
  TOptional,
  TTransform,
  TLiteral,
  OptionalKind,
} from '@sinclair/typebox';
import { Value, TransformDecode } from '@sinclair/typebox/value';

import type { StaticDecode } from './schema-types.ts';

/** Type-only: the key under which a codec's schema type carries its wire type. No schema object has it. */
declare const WIRE: unique symbol;
/**
 * What a codec's schema admits on the wire, before it decodes, carried in its type only: `SchemaInput` reads
 * it, so callers send what the source schema checks rather than what the handler receives.
 */
interface WireType<W> {
  /**
   * The wire type `SchemaInput` reads: what the codec admits before it decodes. Type-only; no schema object
   * has it.
   */
  readonly [WIRE]?: W;
}
/** Defaults are optional on input and materialized before domain execution. */
type InputKeys<P extends TProperties> = {
  [K in keyof P]: P[K] extends { default: unknown } | TOptional<TSchema> ? K : never;
}[keyof P];
/**
 * The type a schema accepts on the wire: a field that is optional or has a default may be omitted, and a
 * field a codec declares (`normalizeSchema`, `transformSchema`, `pipeSchema`) is sent as its source.
 */
export type SchemaInput<S extends TSchema, Depth extends unknown[] = []> = Depth['length'] extends 6
  ? Static<S>
  : typeof WIRE extends keyof S
    ? S extends WireType<infer W>
      ? W
      : never
    : S extends TObject<infer P>
      ? { [K in Exclude<keyof P, InputKeys<P>>]: SchemaInput<P[K], [...Depth, unknown]> } & {
          [K in InputKeys<P>]?: SchemaInput<P[K], [...Depth, unknown]>;
        }
      : S extends TArray<infer I>
        ? SchemaInput<I, [...Depth, unknown]>[]
        : S extends TUnion<infer U>
          ? SchemaInput<U[number], [...Depth, unknown]>
          : Static<S>;

/**
 * One refused field: a code, a message that names the expectation and never the value, and the path to the
 * field.
 */
export interface SchemaIssue {
  /** The kind of issue, such as `invalid_input` for a schema mismatch or `custom` for a refinement. */
  code: string;
  /** Why the field was refused, for people; it names the expectation, never the value. */
  message: string;
  /** The keys and array indexes that lead to the refused field; empty when the whole value is refused. */
  path: (string | number)[];
}
/** Every issue of a refused value, as `readSchema` throws it and `checkSchema` returns it. */
export class SchemaValidationError extends TypeError {
  /** Every issue of the refused value; the error's message is the first one's. */
  readonly issues: SchemaIssue[];
  constructor(issues: SchemaIssue[]) {
    super(issues[0]?.message ?? 'The input does not match its schema.');
    this.name = 'SchemaValidationError';
    this.issues = issues;
  }
}

/** The ordered codec steps a schema runs inside `inputSchema()`. */
const STEPS = Symbol('maximus.schema.steps');
/** The transforms a schema applies after its source value is valid. */
const TRANSFORMERS = Symbol('maximus.schema.transformers');
/** The normalizers a schema applies before its own checks. */
const NORMALIZERS = Symbol('maximus.schema.normalizers');
/** The inspections and refinements a schema runs on a valid value. */
const INSPECTORS = Symbol('maximus.schema.inspectors');
/** The source schema of a `pipeSchema`, which the wire value is first read as. */
const SOURCE = Symbol('maximus.schema.source');
/** Whether an object drops unknown keys when read with `stripUnknown`. */
const STRIP = Symbol('maximus.schema.strip');
/** An inspection: it reads a valid value and adds an issue for each problem it finds. */
type Inspector = (input: unknown, context: { addIssue: (issue: SchemaIssue) => void }) => void;
/** One codec step, in the order the schema declared it. */
type SchemaStep =
  | { kind: 'normalize' | 'transform'; apply: (input: unknown) => unknown }
  | { kind: 'inspect'; apply: Inspector };
/** A TypeBox schema with the codec markers the owner added to it. */
type OwnerSchema = TSchema & {
  [STEPS]?: readonly SchemaStep[];
  [TRANSFORMERS]?: readonly ((input: unknown) => unknown)[];
  [NORMALIZERS]?: readonly ((input: unknown) => unknown)[];
  [INSPECTORS]?: readonly Inspector[];
  [SOURCE]?: TSchema;
  [STRIP]?: boolean;
};

/** A union of literals: `literalUnion(['open', 'done'])`. */
export const literalUnion = <const V extends readonly (string | number | boolean)[]>(values: V) =>
  t.Union(values.map((value: V[number]) => t.Literal(value))) as TUnion<{
    -readonly [K in keyof V]: TLiteral<V[K]>;
  }>;
/**
 * The schema with a default that decoding applies when the field is absent, so the field is optional on the
 * wire.
 */
export const defaultSchema = <S extends TSchema, const D>(schema: S, value: D): S & { default: D } => ({
  ...schema,
  default: value,
});
/**
 * A strict object that, read with `stripUnknown` (as `readSchema` does), drops unknown keys instead of
 * refusing them. Wrap an input that uses it in `inputSchema()`.
 */
export const stripObject = <P extends TProperties>(properties: P): TObject<P> => ({
  ...t.Object(properties, { additionalProperties: false }),
  [STRIP]: true,
});
/** The object, refusing unknown keys even where a read strips them. */
export const strictObject = <S extends TSchema>(schema: S): S => ({
  ...schema,
  additionalProperties: false,
  [STRIP]: false,
});
/** The object, admitting and keeping unknown keys. */
export const looseObject = <S extends TSchema>(schema: S): S => ({
  ...schema,
  additionalProperties: true,
  [STRIP]: false,
});
/** The object with more properties, keeping how it treats unknown keys. */
export const extendObject = <P extends TProperties, Q extends TProperties>(
  schema: TObject<P>,
  properties: Q
): TObject<P & Q> => ({
  ...t.Object({ ...schema.properties, ...properties }, { additionalProperties: schema.additionalProperties }),
  [STRIP]: (schema as OwnerSchema)[STRIP],
});

/** Owner normalization keeps persisted/document input behavior separate from wire validation. */
export const normalizeSchema = <S extends TSchema, O>(schema: S, normalize: (value: Static<S>) => O) =>
  t.Unsafe<O>({
    ...schema,
    [NORMALIZERS]: [...((schema as OwnerSchema)[NORMALIZERS] ?? []), normalize],
    [STEPS]: [...((schema as OwnerSchema)[STEPS] ?? []), { kind: 'normalize', apply: normalize }],
  }) as TUnsafe<O> &
    WireType<SchemaInput<S>> &
    (S extends TOptional<TSchema> ? { [OptionalKind]: 'Optional' } : Record<never, never>) &
    (S extends { default: infer D } ? { default: D } : Record<never, never>);
/** Apply a domain transform only after validating its source value. */
export const transformSchema = <S extends TSchema, O>(schema: S, transform: (value: Static<S>) => O) =>
  t.Unsafe<O>({
    ...schema,
    [TRANSFORMERS]: [...((schema as OwnerSchema)[TRANSFORMERS] ?? []), transform],
    [STEPS]: [...((schema as OwnerSchema)[STEPS] ?? []), { kind: 'transform', apply: transform }],
  }) as TUnsafe<O> &
    WireType<SchemaInput<S>> &
    (S extends TOptional<TSchema> ? { [OptionalKind]: 'Optional' } : Record<never, never>) &
    (S extends { default: infer D } ? { default: D } : Record<never, never>);

/**
 * Admits a value as `source`, then checks and decodes the result as `target`: a wire shape read into its
 * canonical one. Runs inside `inputSchema()`.
 */
export const pipeSchema = <S extends TSchema, O extends TSchema>(
  source: S,
  target: O
): O & WireType<SchemaInput<S>> => ({
  ...target,
  [SOURCE]: source,
});
/**
 * Runs `inspect` on a value the schema admits; every `addIssue` refuses the value with that issue. Runs
 * inside `inputSchema()`.
 */
export const inspectSchema = <S extends TSchema>(
  schema: S,
  inspect: (value: Static<S>, context: { addIssue: (issue: SchemaIssue) => void }) => void
): S => ({
  ...schema,
  [INSPECTORS]: [...((schema as OwnerSchema)[INSPECTORS] ?? []), inspect],
  [STEPS]: [...((schema as OwnerSchema)[STEPS] ?? []), { kind: 'inspect', apply: inspect }],
});
/**
 * Refuses a value the schema admits when `predicate` rejects it, with `detail` as the issue's message and
 * path. Runs inside `inputSchema()`.
 */
export const refineSchema = <S extends TSchema>(
  schema: S,
  predicate: (value: Static<S>) => unknown,
  detail?: string | { message?: string; error?: string; path?: (string | number)[] }
): S =>
  inspectSchema(schema, (value, context) => {
    if (!predicate(value)) {
      context.addIssue({
        code: 'custom',
        message: typeof detail === 'string' ? detail : (detail?.message ?? detail?.error ?? 'Invalid value'),
        path: typeof detail === 'object' ? (detail.path ?? []) : [],
      });
    }
  });
/** A URL whose protocol, and optionally hostname, match the given patterns. Runs inside `inputSchema()`. */
export const urlSchema = (options: { protocol: RegExp; hostname?: RegExp; maxLength?: number }) =>
  refineSchema(
    t.String({ format: 'uri', ...(options.maxLength ? { maxLength: options.maxLength } : {}) }),
    (value) => {
      try {
        const url = new URL(value);
        return (
          options.protocol.test(url.protocol.slice(0, -1)) &&
          (!options.hostname || options.hostname.test(url.hostname))
        );
      } catch {
        return false;
      }
    }
  );

/** Compile owner semantics into real native TypeBox source codecs. Canonical output schemas stay strict. */
const projectOwnerInput = (schema: OwnerSchema, stripUnknown: boolean): TSchema => {
  if (schema[SOURCE]) {
    const source = projectOwnerInput(schema[SOURCE], stripUnknown);
    const targetSchema = { ...schema, [SOURCE]: undefined };
    const target = projectOwnerInput(targetSchema, stripUnknown);
    return t
      .Transform(source)
      .Decode((value) => {
        const targetInput = Value.Default(target, value);
        Value.Assert(target, targetInput);
        return TransformDecode(target, [], targetInput);
      })
      .Encode((value) => value);
  }
  const projected: OwnerSchema = { ...schema };
  if (schema.properties) {
    projected.properties = Object.fromEntries(
      Object.entries(schema.properties as Record<string, OwnerSchema>).map(([key, value]) => [
        key,
        projectOwnerInput(value, stripUnknown),
      ])
    );
    projected.required = (schema.required as string[] | undefined)?.filter(
      (key) => !('default' in schema.properties[key])
    );
    if (stripUnknown && schema[STRIP]) {
      projected.additionalProperties = true;
    }
  }
  if (schema.items) {
    projected.items = Array.isArray(schema.items)
      ? schema.items.map((value) => projectOwnerInput(value, stripUnknown))
      : projectOwnerInput(schema.items, stripUnknown);
  }
  if (schema.anyOf) {
    projected.anyOf = schema.anyOf.map((value: OwnerSchema) => {
      // A nullable text codec normalizes before its union's canonical pattern/length checks.
      if ((schema[NORMALIZERS]?.length ?? 0) > 0 && value.type === 'string') {
        const source = { ...value };
        delete source.pattern;
        delete source.format;
        delete source.minLength;
        delete source.maxLength;
        return projectOwnerInput(source, stripUnknown);
      }
      return projectOwnerInput(value, stripUnknown);
    });
  }
  if (schema.patternProperties) {
    projected.patternProperties = Object.fromEntries(
      Object.entries(schema.patternProperties as Record<string, OwnerSchema>).map(([key, value]) => [
        key,
        projectOwnerInput(value, stripUnknown),
      ])
    );
  }
  const normalizers = schema[NORMALIZERS] ?? [];
  if (schema.type === 'string' && normalizers.length) {
    delete projected.pattern;
    delete projected.format;
    delete projected.minLength;
    delete projected.maxLength;
  }
  const transforms = schema[TRANSFORMERS] ?? [];
  const inspectors = schema[INSPECTORS] ?? [];
  const strip = stripUnknown && schema[STRIP] && schema.properties;
  if (!(normalizers.length || transforms.length || inspectors.length || strip)) {
    return projected;
  }
  return t
    .Transform(projected)
    .Decode((input) => {
      let value = input;
      if (strip && value !== null && typeof value === 'object' && !Array.isArray(value)) {
        value = Object.fromEntries(Object.entries(value).filter(([key]) => key in schema.properties));
      }
      const issues: SchemaIssue[] = [];
      const steps = schema[STEPS] ?? [];
      for (const [index, step] of steps.entries()) {
        if (step.kind === 'inspect') {
          step.apply(value, { addIssue: (issue) => issues.push(issue) });
          if (issues.length) {
            throw new SchemaValidationError(issues);
          }
        } else {
          value = step.apply(value);
          // Text normalization admits a raw spelling before canonical text constraints.
          // Object projections validate their source first and their target through pipeSchema.
          if (
            step.kind === 'normalize' &&
            steps[index + 1]?.kind !== 'normalize' &&
            (schema.type === 'string' ||
              schema.anyOf?.every((branch: TSchema) => branch.type === 'string' || branch.type === 'null')) &&
            !Value.Check(schema, value)
          ) {
            throw new SchemaValidationError([
              { code: 'invalid_input', message: 'The normalized value does not match its schema.', path: [] },
            ]);
          }
        }
      }
      return value;
    })
    .Encode((value) => value);
};
/**
 * Whether a schema carries owner codecs that only `inputSchema()` compiles: a normalizer, transform,
 * inspector or refinement, a `pipeSchema` source, or a `stripObject`. A plain decode ignores their
 * markers, so such a schema used directly as an operation input would admit raw, unnormalized and
 * unrefined values without a word. A compiled subtree (a TypeBox transform) is already honest.
 */
export function hasUncompiledCodecs(schema: TSchema): boolean {
  const seen = new Set<object>();
  /**
   * Whether this schema, or any schema below it that no transform already compiled, carries a codec marker.
   */
  const visit = (node: unknown): boolean => {
    if (!node || typeof node !== 'object' || seen.has(node) || TransformKind in node) {
      return false;
    }
    seen.add(node);
    const owner = node as OwnerSchema;
    if ((owner[STEPS]?.length ?? 0) > 0 || owner[SOURCE] || owner[STRIP] === true) {
      return true;
    }
    const children: unknown[] = [
      ...Object.values((owner.properties as Record<string, unknown> | undefined) ?? {}),
      ...Object.values((owner.patternProperties as Record<string, unknown> | undefined) ?? {}),
      ...[owner.items].flat(),
      ...((owner.anyOf as unknown[] | undefined) ?? []),
      ...((owner.allOf as unknown[] | undefined) ?? []),
      ...((owner.oneOf as unknown[] | undefined) ?? []),
    ];
    return children.some(visit);
  };
  return visit(schema);
}

/**
 * Compiles a schema's codecs (defaults, normalizers, transforms, inspections, refinements, pipes and
 * stripping) into one input schema: the wire accepts `SchemaInput<S>`, and the handler receives the
 * decoded, canonical `StaticDecode<S>`, which is `Static<S>` unless `S` holds a TypeBox transform. An
 * operation whose input uses a codec must be wrapped in it.
 */
export function inputSchema<S extends TSchema>(
  schema: S,
  options?: { stripUnknown?: boolean }
): TTransform<TUnsafe<SchemaInput<S>>, StaticDecode<S>>;
/** The same, reading another wire shape `wire` and decoding it into `schema`'s canonical type. */
export function inputSchema<S extends TSchema, W extends TSchema>(
  schema: S,
  wire: W
): TTransform<W, StaticDecode<S>>;
export function inputSchema<S extends TSchema, W extends TSchema>(
  schema: S,
  source?: W | { stripUnknown?: boolean }
) {
  const wire = source && Kind in source ? (source as W) : undefined;
  const stripUnknown = !wire && source && 'stripUnknown' in source && source.stripUnknown === true;
  const projected = projectOwnerInput(schema, Boolean(stripUnknown));
  return t
    .Transform(t.Unsafe<SchemaInput<S>>(wire ? projectOwnerInput(wire, false) : projected))
    .Decode((input) => {
      if (!wire) {
        return input as StaticDecode<S>;
      }
      const value = Value.Default(projected, input);
      // GET scalar decoding changes the source type; admit its canonical target before owner codecs.
      Value.Assert(projected, value);
      return TransformDecode(projected, [], value) as StaticDecode<S>;
    })
    .Encode((value) => value as SchemaInput<S>);
}
