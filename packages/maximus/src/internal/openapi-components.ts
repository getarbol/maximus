/**
 * The named components of an OpenAPI document, as SDK generators read them: each request body, success
 * envelope and failure a component whose name says what it holds (`CreateNoteBody`, `NoteResponse`,
 * `NoteNotFoundError`), so the types and methods a generator writes read as the API does.
 */
import type { ErrorDefinition } from '../errors.ts';
import { canonical } from '../schema-bundle.ts';

/** A local reference to a component schema. */
export interface SchemaReference {
  $ref: string;
}

/** A reference to the component schema `name`. */
export function schemaReference(name: string): SchemaReference {
  return { $ref: `#/components/schemas/${name}` };
}

/** A camelCase name or an uppercase code in PascalCase: `createNote` is `CreateNote`, `NOTE_NOT_FOUND` `NoteNotFound`. */
export function pascalCase(name: string): string {
  const words = /^[A-Z0-9_]+$/.test(name) ? name.toLowerCase().split('_') : [name];
  return words
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

/** The reason phrase of each HTTP status a failure may answer, in PascalCase, as RFC 9110 names it. */
const REASONS: Readonly<Record<number, string>> = {
  400: 'BadRequest',
  401: 'Unauthorized',
  402: 'PaymentRequired',
  403: 'Forbidden',
  404: 'NotFound',
  405: 'MethodNotAllowed',
  406: 'NotAcceptable',
  408: 'RequestTimeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'LengthRequired',
  412: 'PreconditionFailed',
  413: 'ContentTooLarge',
  415: 'UnsupportedMediaType',
  422: 'UnprocessableContent',
  423: 'Locked',
  424: 'FailedDependency',
  425: 'TooEarly',
  428: 'PreconditionRequired',
  429: 'TooManyRequests',
  451: 'UnavailableForLegalReasons',
  500: 'InternalServerError',
  501: 'NotImplemented',
  502: 'BadGateway',
  503: 'ServiceUnavailable',
  504: 'GatewayTimeout',
  507: 'InsufficientStorage',
};

/** A status's reason phrase in PascalCase: 400 is `BadRequest`, and a status without one `Status499`. */
export function statusReason(status: number): string {
  return REASONS[status] ?? `Status${status}`;
}

/** A failure code without the `_ERROR` its name would repeat: `INTERNAL_ERROR` is `INTERNAL`. */
function failureWords(code: string): string {
  return pascalCase(code.replace(/_ERROR$/, ''));
}

/** The component of one failure: `NOTE_NOT_FOUND` is `NoteNotFoundFailure`. */
export function failureName(code: string): string {
  return `${failureWords(code)}Failure`;
}

/** The envelope of one failure, the answer's whole body: `NOTE_NOT_FOUND` is `NoteNotFoundError`. */
export function failureEnvelopeName(code: string): string {
  return `${failureWords(code)}Error`;
}

/**
 * The names a generator gives each operation's own types, which a component must not take: openapi-typescript
 * and Hey API write `CreateNoteData`, `CreateNoteResponse` and `CreateNoteError`, and the OpenAPI Generator
 * `CreateNoteRequest`.
 */
const GENERATED_SUFFIXES = ['Data', 'Error', 'Errors', 'Response', 'Responses', 'Request'];

/** The component names a generator writes for an operation's own types: `createNote`'s `CreateNoteResponse`. */
export function generatedNames(operation: string): string[] {
  const name = pascalCase(operation);
  return GENERATED_SUFFIXES.map((suffix) => `${name}${suffix}`);
}

/** The component schemas of a document, each name given to one schema only. */
export class ComponentSchemas {
  /** The schemas by name, in the order they were added. */
  readonly schemas: Record<string, unknown> = {};

  /** Whether another schema than this one already has the name. */
  holdsOther(name: string, schema: unknown): boolean {
    const existing = this.schemas[name];
    return existing !== undefined && canonical(existing) !== canonical(schema);
  }

  /**
   * Names a schema and answers a reference to it. The same schema under a name it already has is the same
   * component; another schema under a taken name throws, since a reference would then name two shapes.
   */
  add(name: string, schema: unknown): SchemaReference {
    if (this.holdsOther(name, schema)) {
      throw new TypeError(`Two different schemas claim the OpenAPI component ${name}.`);
    }
    this.schemas[name] = schema;
    return schemaReference(name);
  }
}

/** The JSON a field holds when the answer carries none: success has no error, a failure no data. */
const NONE = { const: null };

/** The metadata every answer carries, as the component `ResponseMetadata`. */
export const RESPONSE_METADATA = {
  type: 'object',
  description: 'What every answer carries besides its data or error.',
  additionalProperties: false,
  required: ['requestId'],
  properties: {
    requestId: {
      type: 'string',
      description: 'Request correlation identifier, also sent as X-Request-Id.',
    },
  },
};

/** The empty object, as the component `Empty`: the data of an answer, or of a failure, that carries none. */
export const EMPTY_OBJECT = {
  type: 'object',
  description: 'No fields.',
  additionalProperties: false,
  properties: {},
};

/** The envelope of a successful answer: `success` is true, `data` the operation's output and `error` null. */
export function successEnvelope(data: unknown): object {
  return {
    type: 'object',
    description: 'A successful answer.',
    additionalProperties: false,
    required: ['success', 'data', 'error', 'metadata'],
    properties: {
      success: { type: 'boolean', enum: [true] },
      data,
      error: NONE,
      metadata: schemaReference('ResponseMetadata'),
    },
  };
}

/** The envelope of a failed answer: `success` is false, `data` null and `error` the failure. */
export function failureEnvelope(error: unknown): object {
  return {
    type: 'object',
    description: 'A failed answer.',
    additionalProperties: false,
    required: ['success', 'data', 'error', 'metadata'],
    properties: {
      success: { type: 'boolean', enum: [false] },
      data: NONE,
      error,
      metadata: schemaReference('ResponseMetadata'),
    },
  };
}

/**
 * One failure as the component its code names: its code a one-value enum, which every generator reads as
 * the literal, its retryability fixed and its data the schema its definition declares. Its message is a
 * plain string: clients branch on the code, never on the text.
 */
export function failureSchema(definition: ErrorDefinition, data: unknown): object {
  return {
    type: 'object',
    description: definition.message,
    additionalProperties: false,
    required: ['code', 'message', 'retryable', 'data'],
    properties: {
      code: {
        type: 'string',
        enum: [definition.code],
        description: 'The failure code, stable across releases.',
      },
      message: {
        type: 'string',
        description: 'What went wrong, for people; it never contains input values.',
      },
      retryable: {
        type: 'boolean',
        enum: [definition.retryable ?? false],
        description: 'Whether repeating the same request may succeed.',
      },
      data,
    },
  };
}

/** Several failures as one component, told apart by their `code`, as generators that read a discriminator expect. */
export function failureUnion(codes: readonly string[]): object {
  return {
    oneOf: codes.map((code) => schemaReference(failureName(code))),
    discriminator: {
      propertyName: 'code',
      mapping: Object.fromEntries(codes.map((code) => [code, schemaReference(failureName(code)).$ref])),
    },
  };
}
