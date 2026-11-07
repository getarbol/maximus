/**
 * Owner codecs on TypeBox schemas: defaults, normalizers, transforms, inspections, refinements, pipes and
 * unknown-key stripping. `inputSchema()` compiles them into TypeBox codecs and refinements, so the wire is
 * checked as declared and the handler receives the decoded value. Every helper copies a schema with what
 * TypeBox keeps hidden on it, as `annotate` does.
 */
import { IsCodec, Type as t } from 'typebox';
import type {
  Static,
  TCodec,
  TSchema,
  TObject,
  TProperties,
  TUnsafe,
  TArray,
  TUnion,
  TOptional,
  TLiteral,
} from 'typebox';
import { Memory } from 'typebox/system';

import { carriedErrors, carriedIssues, SchemaValidationError } from './internal/decode-issues.ts';
import type { SchemaIssue } from './internal/decode-issues.ts';
import { SOURCE, STRIP } from './internal/schema-markers.ts';
import { DecodeUnsafe, HasCodec, Value } from './internal/value.ts';
import type { SchemaKeywords, StaticDecode } from './schema-types.ts';
import { holdsSecrets } from './secrets.ts';

export { SchemaValidationError } from './internal/decode-issues.ts';
export type { SchemaIssue } from './internal/decode-issues.ts';

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

/** The ordered codec steps a schema runs inside `inputSchema()`. */
const STEPS = Symbol('maximus.schema.steps');
/** The transforms a schema applies after its source value is valid. */
const TRANSFORMERS = Symbol('maximus.schema.transformers');
/** The normalizers a schema applies before its own checks. */
const NORMALIZERS = Symbol('maximus.schema.normalizers');
/** The inspections and refinements a schema runs on a valid value. */
const INSPECTORS = Symbol('maximus.schema.inspectors');
/** An inspection: it reads a valid value and adds an issue for each problem it finds. */
type Inspector = (input: unknown, context: { addIssue: (issue: SchemaIssue) => void }) => void;
/** One codec step, in the order the schema declared it. */
type SchemaStep =
  | { kind: 'normalize' | 'transform'; apply: (input: unknown) => unknown }
  | { kind: 'inspect'; apply: Inspector };
/** A TypeBox schema with the codec markers the owner added to it. */
type OwnerSchema = SchemaKeywords & {
  [STEPS]?: readonly SchemaStep[];
  [TRANSFORMERS]?: readonly ((input: unknown) => unknown)[];
  [NORMALIZERS]?: readonly ((input: unknown) => unknown)[];
  [INSPECTORS]?: readonly Inspector[];
  [SOURCE]?: TSchema;
  [STRIP]?: boolean;
};

/**
 * The schema with `options` added (`description`, `examples`, `default`, …), keeping what TypeBox keeps hidden
 * on it: an optional field stays optional, a codec or a refinement stays one. Spreading a schema into an
 * object literal, `{ ...schema, description }`, loses them.
 */
export const annotate = <S extends TSchema, const O extends Record<string, unknown>>(
  schema: S,
  options: O
): S & O => Memory.Update(schema, {}, options) as S & O;

/**
 * The literals of a union, as TypeBox types its members: one per value of a tuple, or for an array of unknown
 * length one literal of every value it may hold, since TypeBox reads a union's members as a tuple.
 */
type LiteralMembers<V extends readonly (string | number | boolean)[]> = number extends V['length']
  ? [TLiteral<V[number]>]
  : { -readonly [K in keyof V]: TLiteral<V[K]> };
/** A union of literals: `literalUnion(['open', 'done'])`, or the values of a list, `literalUnion(ids)`. */
export const literalUnion = <const V extends readonly (string | number | boolean)[]>(values: V) =>
  t.Union(values.map((value: V[number]) => t.Literal(value))) as TUnion<LiteralMembers<V>>;
/**
 * The schema with a default that decoding applies when the field is absent, so the field is optional on the
 * wire.
 */
export const defaultSchema = <S extends TSchema, const D>(schema: S, value: D): S & { default: D } =>
  annotate(schema, { default: value });
/**
 * A strict object that, read with `stripUnknown` (as `readSchema` does), drops unknown keys instead of
 * refusing them. Wrap an input that uses it in `inputSchema()`.
 */
export const stripObject = <P extends TProperties>(properties: P): TObject<P> =>
  annotate(t.Object(properties, { additionalProperties: false }), { [STRIP]: true });
/** The object, refusing unknown keys even where a read strips them. */
export const strictObject = <S extends TSchema>(schema: S): S =>
  annotate(schema, { additionalProperties: false, [STRIP]: false });
/** The object, admitting and keeping unknown keys. */
export const looseObject = <S extends TSchema>(schema: S): S =>
  annotate(schema, { additionalProperties: true, [STRIP]: false });
/** The object with more properties, keeping how it treats unknown keys. */
export const extendObject = <P extends TProperties, Q extends TProperties>(
  schema: TObject<P>,
  properties: Q
): TObject<P & Q> =>
  annotate(
    t.Object({ ...schema.properties, ...properties } as P & Q, {
      additionalProperties: (schema as SchemaNode).additionalProperties as boolean | undefined,
    }),
    { [STRIP]: (schema as OwnerSchema)[STRIP] }
  );

/**
 * Reads a field through `normalize`. For a string, or a string that may be null, the pattern, format and
 * lengths apply to the normalized value, so the wire may send a raw spelling (another case, surrounding
 * spaces); any other schema checks the raw value first. The wire type stays the schema's own. Runs inside
 * `inputSchema()`.
 */
export const normalizeSchema = <S extends TSchema, O>(schema: S, normalize: (value: Static<S>) => O) =>
  t.Unsafe<O>(
    annotate(schema, {
      [NORMALIZERS]: [...((schema as OwnerSchema)[NORMALIZERS] ?? []), normalize],
      [STEPS]: [...((schema as OwnerSchema)[STEPS] ?? []), { kind: 'normalize', apply: normalize }],
    })
  ) as TUnsafe<O> &
    WireType<SchemaInput<S>> &
    (S extends TOptional<TSchema> ? { '~optional': true } : Record<never, never>) &
    (S extends { default: infer D } ? { default: D } : Record<never, never>);
/**
 * Decodes a field with `transform` once its value passes `schema`: the wire sends what `schema` checks, and
 * the handler receives what `transform` returns. Runs inside `inputSchema()`.
 */
export const transformSchema = <S extends TSchema, O>(schema: S, transform: (value: Static<S>) => O) =>
  t.Unsafe<O>(
    annotate(schema, {
      [TRANSFORMERS]: [...((schema as OwnerSchema)[TRANSFORMERS] ?? []), transform],
      [STEPS]: [...((schema as OwnerSchema)[STEPS] ?? []), { kind: 'transform', apply: transform }],
    })
  ) as TUnsafe<O> &
    WireType<SchemaInput<S>> &
    (S extends TOptional<TSchema> ? { '~optional': true } : Record<never, never>) &
    (S extends { default: infer D } ? { default: D } : Record<never, never>);

/**
 * Refuses a canonical schema that marks a field `secret: true` when the wire schema it is read from marks
 * nothing: capture reads the value the wire schema checked, where that mark would protect nothing.
 */
function requireSecretsOnWire(wire: TSchema, canonical: TSchema): void {
  if (holdsSecrets(canonical) && !holdsSecrets(wire)) {
    throw new TypeError(
      'A canonical schema marks a field secret: true and the wire schema it is read from does not; mark the field where the wire carries it.'
    );
  }
}
/**
 * Admits a value as `source`, then checks and decodes the result as `target`: a wire shape read into its
 * canonical one. Runs inside `inputSchema()`. A `target` that marks a field `secret: true` needs `source` to
 * mark it too, or it throws a TypeError.
 */
export const pipeSchema = <S extends TSchema, O extends TSchema>(
  source: S,
  target: O
): O & WireType<SchemaInput<S>> => {
  requireSecretsOnWire(source, target);
  return annotate(target, { [SOURCE]: source }) as O & WireType<SchemaInput<S>>;
};
/**
 * Runs `inspect` on a value the schema admits; every `addIssue` refuses the value with that issue. Runs
 * inside `inputSchema()`.
 */
export const inspectSchema = <S extends TSchema>(
  schema: S,
  inspect: (value: Static<S>, context: { addIssue: (issue: SchemaIssue) => void }) => void
): S =>
  annotate(schema, {
    [INSPECTORS]: [...((schema as OwnerSchema)[INSPECTORS] ?? []), inspect],
    [STEPS]: [...((schema as OwnerSchema)[STEPS] ?? []), { kind: 'inspect', apply: inspect }],
  });
/**
 * Refuses a value the schema admits when `predicate` rejects it, with a `custom` issue whose message and path
 * `detail` gives (`Invalid value` at the field by default). Runs inside `inputSchema()`.
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
/**
 * A URL, of at most `maxLength` characters when given, whose protocol (without its colon, such as `https`)
 * and, optionally, hostname match the given patterns. Runs inside `inputSchema()`.
 */
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

/** A node of a schema, as JSON Schema reads it, with the markers its codecs left on it. */
type SchemaNode = OwnerSchema;

/** Whether a schema is text, or text that may be null: what a normalizer checks again once it has run. */
function textual(schema: SchemaNode): boolean {
  return (
    schema.type === 'string' ||
    (Array.isArray(schema.anyOf) &&
      schema.anyOf.every((branch: SchemaNode) => branch.type === 'string' || branch.type === 'null'))
  );
}

/**
 * A node's own codec steps, run in their order on its value once its children are decoded: the decoded value,
 * or the issues that refuse it, at their paths below the node. A step that throws a `SchemaValidationError`
 * refuses with its issues; anything else it throws is the codec's fault and propagates.
 */
function runSteps(
  schema: SchemaNode,
  input: unknown,
  strip: boolean
): { value: unknown; issues: SchemaIssue[] } {
  let value = input;
  if (strip && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    value = Object.fromEntries(Object.entries(value).filter(([key]) => key in (schema.properties as object)));
  }
  const steps = schema[STEPS] ?? [];
  for (const [index, step] of steps.entries()) {
    if (step.kind === 'inspect') {
      const issues: SchemaIssue[] = [];
      step.apply(value, { addIssue: (issue) => issues.push(issue) });
      if (issues.length) {
        return { value, issues };
      }
      continue;
    }
    try {
      value = step.apply(value);
    } catch (error) {
      if (error instanceof SchemaValidationError) {
        return { value, issues: error.issues };
      }
      throw error;
    }
    // Text normalization admits a raw spelling before canonical text constraints.
    if (
      step.kind === 'normalize' &&
      steps[index + 1]?.kind !== 'normalize' &&
      textual(schema) &&
      !Value.Check(schema, value)
    ) {
      return {
        value,
        issues: [
          { code: 'invalid_input', message: 'The normalized value does not match its schema.', path: [] },
        ],
      };
    }
  }
  return { value, issues: [] };
}

/** A copy of a value decoded through a schema's codecs: a check never changes the value it checks. */
function decodedCopy(schema: TSchema, value: unknown): unknown {
  return HasCodec(schema) ? DecodeUnsafe({}, schema, Value.Clone(value)) : value;
}

/**
 * A node with owner steps as TypeBox runs it: a refinement that runs the steps on the value, its children
 * decoded, and refuses with their issues, and a codec that decodes the value through them.
 */
function ownerNode(projected: TSchema, schema: SchemaNode, strip: boolean): TSchema {
  const issuesOf = (input: unknown) => runSteps(schema, decodedCopy(projected, input), strip).issues;
  const refined = t.Refine(
    projected,
    (input) => issuesOf(input).length === 0,
    (input) => carriedIssues(issuesOf(input))
  );
  return t
    .Codec(refined)
    .Decode((value) => runSteps(schema, value, strip).value)
    .Encode((value) => value);
}

/**
 * A `pipeSchema` as TypeBox runs it: the value read as `source`, then defaulted, checked and decoded as
 * `target`. Refused as the source refuses it, else with the target's issues at their paths.
 */
function pipeNode(source: TSchema, target: TSchema): TSchema {
  const targetInput = (input: unknown) => Value.Default(target, decodedCopy(source, input));
  const refined = t.Refine(
    source,
    // A value its source refuses is the source's to report.
    (input) => !Value.Check(source, input) || Value.Check(target, targetInput(input)),
    (input) => carriedErrors(Value.Errors(target, targetInput(input)))
  );
  return t
    .Codec(refined)
    .Decode((value) => DecodeUnsafe({}, target, Value.Default(target, value)))
    .Encode((value) => value);
}

/**
 * Compiles owner semantics into TypeBox codecs and refinements; canonical output schemas stay strict. Every
 * node is copied with what TypeBox keeps hidden on it, a refinement or a codec among them.
 */
const projectOwnerInput = (schema: OwnerSchema, stripUnknown: boolean): TSchema => {
  const node = schema as SchemaNode;
  if (node[SOURCE]) {
    const source = projectOwnerInput(node[SOURCE], stripUnknown);
    const target = projectOwnerInput(Memory.Update(node, {}, { [SOURCE]: undefined }), stripUnknown);
    return pipeNode(source, target);
  }
  const projected = Memory.Update(node, {}, {}) as SchemaNode;
  const properties = node.properties as Record<string, OwnerSchema> | undefined;
  if (properties) {
    projected.properties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, projectOwnerInput(value, stripUnknown)])
    );
    projected.required = (node.required as string[] | undefined)?.filter(
      (key) => !('default' in (properties[key] ?? {}))
    );
    if (stripUnknown && node[STRIP]) {
      projected.additionalProperties = true;
    }
  }
  if (node.items) {
    projected.items = Array.isArray(node.items)
      ? node.items.map((value: OwnerSchema) => projectOwnerInput(value, stripUnknown))
      : projectOwnerInput(node.items as OwnerSchema, stripUnknown);
  }
  const normalizers = node[NORMALIZERS] ?? [];
  if (Array.isArray(node.anyOf)) {
    projected.anyOf = node.anyOf.map((value: SchemaNode) => {
      // A nullable text codec normalizes before its union's canonical pattern/length checks.
      if (normalizers.length > 0 && value.type === 'string') {
        const source = Memory.Update(value, {}, {}) as SchemaNode;
        delete source.pattern;
        delete source.format;
        delete source.minLength;
        delete source.maxLength;
        return projectOwnerInput(source, stripUnknown);
      }
      return projectOwnerInput(value, stripUnknown);
    });
  }
  if (node.patternProperties) {
    projected.patternProperties = Object.fromEntries(
      Object.entries(node.patternProperties as Record<string, OwnerSchema>).map(([key, value]) => [
        key,
        projectOwnerInput(value, stripUnknown),
      ])
    );
  }
  if (node.type === 'string' && normalizers.length) {
    delete projected.pattern;
    delete projected.format;
    delete projected.minLength;
    delete projected.maxLength;
  }
  const strip = Boolean(stripUnknown && node[STRIP] && properties);
  if (!((node[STEPS]?.length ?? 0) > 0 || strip)) {
    return projected;
  }
  return ownerNode(projected, node, strip);
};
/**
 * An input schema as callers send it, for the documents that publish it: a field with a default is optional,
 * since decoding fills it in. A schema `inputSchema()` compiled is its wire form already.
 */
export function wireInput(schema: TSchema): TSchema {
  return IsCodec(schema) ? schema : projectOwnerInput(schema as OwnerSchema, false);
}

/**
 * Whether a schema carries owner codecs that only `inputSchema()` compiles: a normalizer, transform,
 * inspector or refinement, a `pipeSchema` source, or a `stripObject`. A plain decode ignores their
 * markers, so such a schema used directly as an operation input would admit raw, unnormalized and
 * unrefined values without a word. A compiled subtree (a TypeBox codec) is already honest.
 */
export function hasUncompiledCodecs(schema: TSchema): boolean {
  const seen = new Set<object>();
  /**
   * Whether this schema, or any schema below it that no transform already compiled, carries a codec marker.
   */
  const visit = (node: unknown): boolean => {
    if (!node || typeof node !== 'object' || seen.has(node) || IsCodec(node)) {
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
): TCodec<TUnsafe<SchemaInput<S>>, StaticDecode<S>>;
/** The same, reading another wire shape `wire` and decoding it into `schema`'s canonical type. */
export function inputSchema<S extends TSchema, W extends TSchema>(
  schema: S,
  wire: W
): TCodec<W, StaticDecode<S>>;
export function inputSchema<S extends TSchema, W extends TSchema>(
  schema: S,
  source?: W | { stripUnknown?: boolean }
) {
  // The options hold `stripUnknown` alone; anything else is the wire schema.
  const options = source && Object.keys(source).every((key) => key === 'stripUnknown') ? source : undefined;
  const wire = source && !options ? (source as W) : undefined;
  if (wire) {
    requireSecretsOnWire(wire, schema);
  }
  const stripUnknown = (options as { stripUnknown?: boolean } | undefined)?.stripUnknown === true;
  const projected = projectOwnerInput(schema, stripUnknown);
  return t
    .Codec(t.Unsafe<SchemaInput<S>>(wire ? projectOwnerInput(wire, false) : projected))
    .Decode((input) => {
      if (!wire) {
        return input as StaticDecode<S>;
      }
      const value = Value.Default(projected, input);
      // GET scalar decoding changes the source type; admit its canonical target before owner codecs.
      Value.Assert(projected, value);
      return DecodeUnsafe({}, projected, value) as StaticDecode<S>;
    })
    .Encode((value) => value as SchemaInput<S>);
}
