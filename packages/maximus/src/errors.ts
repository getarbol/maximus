/**
 * `@arbol-ai/maximus/errors`: error catalogs. `defineErrors` joins the standard failures and an
 * application's own into one catalog whose factories build each failure and whose schema validates every
 * failure an operation returns.
 */
import { Type } from '@sinclair/typebox';
import type { Static, TLiteral, TSchema, TObject, TProperties, TUnion } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { STANDARD_FAILURES } from './standard-failures.ts';
import { parseSchema } from './validation.ts';

/** The `data` of a failure whose code declares none: an empty object. */
export interface FailureData {}
/**
 * A failure as every transport carries it: a stable code, a message for people that never contains input
 * values, whether repeating the request may succeed, and the data its code declares. Its fields come from
 * `FailureSchema`, so the type and the wire schema cannot drift apart.
 */
export type Failure<Data = FailureData> = Omit<Static<typeof FailureSchema>, 'data'> & {
  /**
   * The details the code declares, such as `issues` for `INVALID_INPUT`; an empty object when it declares
   * none.
   */
  data: Data;
};
/**
 * One failure of a catalog: its code, HTTP status, message, retryability, Retry-After seconds and,
 * optionally, the strict schema of its data.
 */
export interface ErrorDefinition {
  /** The stable code clients branch on, such as `RATE_LIMITED`; unique within the catalog. */
  code: string;
  /** The HTTP status that answers the failure, from 400 to 599. */
  status: number;
  /** A fixed message for people; it never carries request data. */
  message: string;
  /** Whether the same request may succeed later; false when absent. */
  retryable?: boolean;
  /** The seconds a client waits before retrying, sent as `Retry-After`. */
  retryAfter?: number;
  /** Explicit, strict domain diagnostics; omitted definitions retain empty data. */
  dataSchema?: TObject<TProperties>;
}
/**
 * Every failure, whatever its code: the base each catalog's failures narrow. The OpenAPI document
 * names it `Failure`, so every service's errors share one type.
 */
export const FailureSchema = Type.Object(
  {
    code: Type.String({ description: 'The failure code, stable across releases.' }),
    message: Type.String({ description: 'What went wrong, for people; it never contains input values.' }),
    retryable: Type.Boolean({ description: 'Whether repeating the same request may succeed.' }),
    data: Type.Object({}, { description: 'Diagnostics the code declares; empty for most codes.' }),
  },
  { $id: 'Failure', additionalProperties: false }
);
/** The first field issues of a refused input: where, and what was expected. Never a value. */
const InputIssuesSchema = Type.Object(
  {
    issues: Type.Optional(
      Type.Array(
        Type.Object(
          {
            path: Type.String({
              maxLength: 256,
              description: 'RFC 6901 JSON Pointer to the refused field; empty for the whole input.',
            }),
            message: Type.String({ maxLength: 256 }),
          },
          { $id: 'ValidationIssue', additionalProperties: false }
        ),
        { maxItems: 10 }
      )
    ),
  },
  { additionalProperties: false }
);
/** The standard failures as a catalog defines them; INVALID_INPUT carries its field issues. */
const STANDARD = {
  ...STANDARD_FAILURES,
  invalidInput: { ...STANDARD_FAILURES.invalidInput, dataSchema: InputIssuesSchema },
} as const satisfies Record<string, ErrorDefinition>;
/** The schema of a definition's data: the one it declares, or the empty object. */
type DefinitionDataSchema<D extends ErrorDefinition> = D extends {
  dataSchema: infer S extends TObject<TProperties>;
}
  ? S
  : TObject<Record<never, never>>;
/** What a failure's `create()` takes: the data its definition declares, optional when every field is. */
type CreateArguments<D extends ErrorDefinition> = D extends { dataSchema: TObject<TProperties> }
  ? Record<never, never> extends Static<DefinitionDataSchema<D>>
    ? [data?: Static<DefinitionDataSchema<D>>]
    : [data: Static<DefinitionDataSchema<D>>]
  : [];
/** The strict schema of one catalog failure: its fixed code and message, its retryability and its data. */
type FailureSchemaOf<D extends ErrorDefinition> = TObject<{
  code: TLiteral<D['code']>;
  message: TLiteral<D['message']>;
  retryable: TLiteral<boolean>;
  data: DefinitionDataSchema<D>;
}>;
/**
 * One failure of a catalog, as `catalog.<name>` holds it: its schema, `create()`, which builds the failure,
 * and `is()`, which recognizes it.
 */
export interface ErrorFactory<D extends ErrorDefinition> {
  /** The failure's strict schema: its fixed code and message, its retryability and its data. */
  schema: FailureSchemaOf<D>;
  /** The failure, with the data its definition declares: required unless every field is optional. */
  create: (
    ...args: CreateArguments<D>
  ) => Failure<Static<DefinitionDataSchema<D>>> & Pick<D, 'code' | 'message'>;
  /** Whether a value is exactly this failure. */
  is: (value: unknown) => value is Static<FailureSchemaOf<D>>;
}
/** One failure's schema, its `create()` and its `is()`, from its definition. */
function factory<const D extends ErrorDefinition>(definition: D): ErrorFactory<D> {
  const dataSchema = (definition.dataSchema ??
    Type.Object({}, { additionalProperties: false })) as DefinitionDataSchema<D>;
  const schema = Type.Object(
    {
      code: Type.Literal<D['code']>(definition.code),
      message: Type.Literal<D['message']>(definition.message),
      retryable: Type.Literal(definition.retryable ?? false),
      data: dataSchema,
    },
    { additionalProperties: false }
  );
  return {
    schema,
    create(...args) {
      const data = parseSchema(dataSchema, args.at(0) ?? {});
      return {
        code: definition.code,
        message: definition.message,
        retryable: definition.retryable ?? false,
        data,
      };
    },
    is(value: unknown): value is Static<typeof schema> {
      return Value.Check(schema, value);
    },
  };
}
/** A catalog's factories, one per definition name. */
type Factories<D extends Record<string, ErrorDefinition>> = {
  [K in keyof D]: ErrorFactory<D[K]>;
};
/**
 * What every catalog provides besides each failure's factory: the union schema of its failures, their
 * definitions, and a failure's status, Retry-After and validation by code.
 */
export interface ErrorCatalog {
  /** The union of the catalog's failure schemas, one strict schema per definition. */
  schema: TSchema;
  /** Every definition of the catalog, standard and domain, by name. */
  definitions: Readonly<Record<string, ErrorDefinition>>;
  /** The HTTP status of a code; 500 for a code the catalog does not define. */
  status: (code: string) => number;
  /** The Retry-After seconds a code declares, if any. */
  retryAfter: (code: string) => number | undefined;
  /** The value as one of the catalog's failures; throws a TypeError when it is none of them. */
  validate: (error: unknown) => Failure;
}
/** The union schema of a set of definitions: one strict failure schema per definition. */
type CatalogSchema<Definitions extends Record<string, ErrorDefinition>> = TUnion<
  { [K in keyof Definitions]: FailureSchemaOf<Definitions[K]> }[keyof Definitions][]
>;
/** A catalog over a set of definitions: a factory per name, and the members of `ErrorCatalog`. */
type Catalog<Definitions extends Record<string, ErrorDefinition>> = Factories<Definitions> & {
  /** The union of the catalog's failure schemas. */
  schema: CatalogSchema<Definitions>;
  /** Every definition of the catalog, by name. */
  definitions: Definitions;
  /** The HTTP status of a code; 500 for a code the catalog does not define. */
  status: (code: string) => number;
  /** The Retry-After seconds a code declares, if any. */
  retryAfter: (code: string) => number | undefined;
  /** The value as one of the catalog's failures; a TypeError when it is none of them. */
  validate: (error: unknown) => Static<CatalogSchema<Definitions>>;
};
/**
 * What `defineErrors` returns for an application's own definitions `D`: a factory for each failure,
 * standard and domain, by name, and the members every `ErrorCatalog` has.
 */
export type DefinedErrors<D extends Record<string, ErrorDefinition>> = Catalog<typeof STANDARD & D>;
/**
 * The names a domain failure cannot take: the standard failures' (every catalog has them) and the
 * catalog's own members (they would hide the failure's factory).
 */
type ReservedName = keyof typeof STANDARD | keyof ErrorCatalog;
/** The domain definitions as given, or, when they use a reserved name, a type that refuses each one. */
type WithoutReservedNames<D> = [Extract<keyof D, ReservedName>] extends [never]
  ? D
  : Readonly<Record<Extract<keyof D, ReservedName>, never>>;
/** The catalog's own members, which no failure may be named after. */
const CATALOG_MEMBERS = {
  schema: true,
  definitions: true,
  status: true,
  retryAfter: true,
  validate: true,
} as const satisfies Record<keyof ErrorCatalog, true>;
/**
 * An error catalog: the standard failures and the application's own, each with a fixed code, status, message
 * and retry semantics. `catalog.name.create(data?)` builds a failure; the application validates every failure
 * an operation returns against the catalog.
 */
export function defineErrors<const D extends Record<string, ErrorDefinition>>(
  domain: WithoutReservedNames<D>
): DefinedErrors<D> {
  // The type refuses these names already; a caller without types, or one that casts, is refused here.
  const own = domain as D;
  if (
    Object.keys(own).some((name) => Object.hasOwn(STANDARD, name) || Object.hasOwn(CATALOG_MEMBERS, name))
  ) {
    throw new TypeError('Domain errors cannot replace framework errors or catalog members.');
  }
  const definitions = { ...STANDARD, ...own };
  const byCode = new Map<string, ErrorDefinition>();
  for (const definition of Object.values<ErrorDefinition>(definitions)) {
    if (byCode.has(definition.code) || definition.status < 400 || definition.status > 599) {
      throw new TypeError('Error definitions require unique codes and failure statuses.');
    }
    if (
      'dataSchema' in definition &&
      definition.dataSchema &&
      (definition.dataSchema.type !== 'object' || definition.dataSchema.additionalProperties !== false)
    ) {
      throw new TypeError('Domain error data must be a strict object schema.');
    }
    byCode.set(definition.code, definition);
  }
  const factories = Object.fromEntries(
    Object.entries(definitions).map(([name, value]) => [name, factory(value)])
  ) as unknown as Factories<typeof STANDARD & D>;
  // Exactly the factories' schemas, which the catalog's type names failure by failure.
  const schema = Type.Union(
    Object.values<{ schema: TSchema }>(factories).map((value) => value.schema)
  ) as CatalogSchema<typeof STANDARD & D>;
  return Object.assign(factories, {
    schema,
    definitions,
    status(code: string) {
      return byCode.get(code)?.status ?? 500;
    },
    retryAfter(code: string) {
      return byCode.get(code)?.retryAfter;
    },
    validate(error: unknown) {
      return parseSchema(schema, error);
    },
  });
}
/**
 * The catalog of the framework's own failures (`INVALID_INPUT`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, …).
 */
export const standardErrors = defineErrors({});
/** The schema of a Result: `{ ok: true, value } | { ok: false, error }`. */
export function resultSchema<O extends TSchema, F extends TSchema>(value: O, error: F) {
  return Type.Union([
    Type.Object({ ok: Type.Literal(true), value }, { additionalProperties: false }),
    Type.Object({ ok: Type.Literal(false), error }, { additionalProperties: false }),
  ]);
}

/** Failure presentation may carry only canonical technical correlation identifiers. */
export { isRequestId } from './internal/correlation.ts';
