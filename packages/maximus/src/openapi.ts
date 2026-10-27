/**
 * An application's OpenAPI 3.1 document, as its origin serves it and as SDK generators read it: one tag per
 * group of routes, and every request body, success envelope and failure a named component, so a generated
 * client reads `createNote(body: CreateNoteBody): NoteResponse`. The `x-*` extensions carry what OpenAPI
 * cannot say: scopes, effects, limits, MCP tools and native RPC.
 */
import { Type } from '@sinclair/typebox';
import type { TSchema } from '@sinclair/typebox';

import { usesCloudflareAccess } from './cloudflare-access.ts';
import type { ErrorDefinition } from './errors.ts';
import { operationPathParameters } from './http-paths.ts';
import { wireInput } from './input-schemas.ts';
import { queryKinds } from './internal/http-query.ts';
import { pathParameterSchemas, routeGroup } from './internal/http-routes.ts';
import {
  ComponentSchemas,
  EMPTY_OBJECT,
  RESPONSE_METADATA,
  failureEnvelope,
  failureEnvelopeName,
  failureName,
  failureSchema,
  failureUnion,
  generatedNames,
  pascalCase,
  schemaReference,
  statusReason,
  successEnvelope,
} from './internal/openapi-components.ts';
import type { SchemaReference } from './internal/openapi-components.ts';
import {
  BODY_CODES,
  STANDARD_CODES,
  isPublicOperation,
  mcpOpenWorld,
  operationBodyLimit,
  operationOutputLimit,
  operationScopes,
} from './manifest.ts';
import type { AppManifest, OperationShape } from './manifest.ts';
import { bundleSchemas, schemaIds } from './schema-bundle.ts';
import { tokenEndpoints } from './tokens.ts';
import type { TokenPolicy } from './tokens.ts';

/** The standard failures only routing answers, before a request reaches any operation's route. */
const ROUTING_CODES: ReadonlySet<string> = new Set(['NOT_FOUND', 'HTTP_METHOD_NOT_ALLOWED']);

/** The headers every answer, and a failure that asks for a wait, carry, as the document's components. */
const HEADERS = {
  RequestId: { description: 'Request correlation identifier.', schema: { type: 'string' } },
  RetryAfter: { description: 'Seconds before another attempt.', schema: { type: 'integer', minimum: 0 } },
};

/** A reference to one of `HEADERS`. */
function headerReference(name: keyof typeof HEADERS): { $ref: string } {
  return { $ref: `#/components/headers/${name}` };
}

/** Whether an object schema holds no field at all, so that `{}` is its one value. */
function isEmptyObject(schema: TSchema): boolean {
  return (
    schema.type === 'object' &&
    Object.keys(schema.properties ?? {}).length === 0 &&
    schema.patternProperties === undefined &&
    schema.additionalProperties === false
  );
}

/**
 * A request body without the fields its path carries, in each member of a union. An object that loses
 * fields is no longer the schema its `$id` names, so it loses the name, and its property counts lose the
 * path's fields.
 */
function bodyWithoutPathParameters(input: TSchema, names: ReadonlySet<string>): TSchema {
  if (input.type !== 'object') {
    const { $id: _id, ...union } = input;
    return {
      ...union,
      anyOf: input.anyOf.map((schema: TSchema) => bodyWithoutPathParameters(schema, names)),
    };
  }
  const carried = Object.keys(input.properties ?? {}).filter((name) => names.has(name)).length;
  if (!carried) {
    return input;
  }
  const { $id: _id, minProperties, maxProperties, ...object } = input;
  return {
    ...object,
    properties: Object.fromEntries(Object.entries(input.properties).filter(([name]) => !names.has(name))),
    required: (input.required ?? []).filter((name: string) => !names.has(name)),
    ...(typeof minProperties === 'number' && minProperties > carried
      ? { minProperties: minProperties - carried }
      : {}),
    ...(typeof maxProperties === 'number' ? { maxProperties: maxProperties - carried } : {}),
  } as TSchema;
}

/** An OpenAPI document as Maximus writes it: JSON, with its paths, component schemas and extensions. */
export interface OpenApiDocument {
  /** The document's other fields: `openapi`, `info`, `servers` and `tags`. */
  [key: string]: unknown;
  /** The OpenAPI `paths` object: each route template, with its operation under the lowercase HTTP method. */
  paths: unknown;
  /**
   * The OpenAPI `components` object: the named `schemas`, such as `CreateNoteBody`, `NoteResponse` and
   * `NoteNotFoundError`, the `headers` and the `securitySchemes`.
   */
  components: { [key: string]: unknown; schemas: Record<string, unknown> };
}

/**
 * The document the origin serves at `/openapi.json`: every public operation that declares an HTTP route,
 * never an internal one, under one tag per group. Each request body, success envelope and failure is a named
 * component, which a generated client names its types after; each operation also carries its scopes,
 * effect, limits in force, MCP tool hints and native RPC as `x-*` extensions.
 *
 * Every schema reference in it is a local `#/components/schemas/<name>` pointer: the `$id`-named
 * schemas of its paths and components (TypeBox Recursive/Ref) become components, as `bundleSchemas`
 * describes. A schema `$id` that takes the name of a component the document writes itself, and a component
 * named as a generator names an operation's own types, such as `CreateNoteResponse`, throw a TypeError.
 */
export function createOpenApi<E, C, O extends Record<string, OperationShape>>(
  manifest: AppManifest<E, C, O>,
  options?: {
    /**
     * Adds an adapter's `x-` extensions to each documented operation, from its name and declaration; a key
     * without the `x-` prefix throws a TypeError. Schemas in the extensions are bundled into the document's
     * components with the rest.
     */
    operationExtensions?: (name: string, operation: OperationShape) => Record<`x-${string}`, unknown>;
  }
): Record<string, unknown> {
  const document = openApiDocument(manifest);
  if (options?.operationExtensions) {
    const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;
    for (const methods of Object.values(paths)) {
      for (const declared of Object.values(methods)) {
        const name = String(declared.operationId);
        const operation = manifest.operations[name];
        if (!operation) {
          throw new TypeError('The document names an undeclared operation.');
        }
        const extensions = options.operationExtensions(name, operation);
        if (Object.keys(extensions).some((key) => !key.startsWith('x-'))) {
          throw new TypeError('OpenAPI extensions must use x- names.');
        }
        Object.assign(declared, extensions);
      }
    }
  }
  const own = Object.entries(document.components.schemas);
  const sources = [document.paths, ...own.map(([, schema]) => schema)];
  checkComponentNames(
    own.map(([name]) => name),
    schemaIds(sources),
    Object.keys(manifest.operations)
  );
  const bundled = bundleSchemas(sources, document.components.schemas);
  const [paths, ...schemas] = bundled.values;
  const named = {
    ...Object.fromEntries(own.map(([name], index) => [name, schemas[index]])),
    ...bundled.components,
  };
  return {
    ...document,
    paths,
    components: {
      ...document.components,
      // In name order, so that the document's text changes only where its schemas do.
      schemas: Object.fromEntries(Object.entries(named).toSorted(([a], [b]) => (a < b ? -1 : Number(a > b)))),
    },
  };
}

/**
 * Refuses the names a document cannot publish: a schema `$id` that takes the name of a component the document
 * writes itself, which bundling would otherwise rename, and a component a generator would name an operation's
 * own types after (`CreateNoteResponse` for `createNote`).
 */
function checkComponentNames(
  own: readonly string[],
  ids: ReadonlySet<string>,
  operations: readonly string[]
) {
  const taken = new Set(own);
  for (const id of ids) {
    if (taken.has(id)) {
      throw new TypeError(
        `The schema $id "${id}" is the name of a component the OpenAPI document writes for its bodies, answers or failures; rename the schema.`
      );
    }
  }
  const generated = new Map(
    operations.flatMap((operation) => generatedNames(operation).map((name) => [name, operation]))
  );
  for (const name of [...own, ...ids]) {
    const operation = generated.get(name);
    if (operation) {
      throw new TypeError(
        `The OpenAPI component ${name} takes the name a generated client gives operation "${operation}"'s own types; rename the schema or the operation.`
      );
    }
  }
}

/** The document `createOpenApi` builds, before its `$id`-named schemas are bundled. */
function openApiDocument<E, C, O extends Record<string, OperationShape>>(
  manifest: AppManifest<E, C, O>
): OpenApiDocument {
  // Each public operation that declares a route, with that route.
  const entries = Object.entries(manifest.operations).flatMap(([name, op]) =>
    op.http && isPublicOperation(op) ? [[name, op, op.http] as const] : []
  );
  const scopes = Object.fromEntries(
    entries.flatMap(([, op]) =>
      [...operationScopes(op), ...(op.conditionalScopes ?? [])].map((scope) => [
        scope,
        scopeDescription(scope),
      ])
    )
  );
  const components = new ComponentSchemas();
  components.add('ResponseMetadata', RESPONSE_METADATA);
  const headers = new Set<keyof typeof HEADERS>(['RequestId']);
  const groups: string[] = [];
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [name, op, http] of entries) {
    const group = op.group ?? routeGroup(http.path) ?? manifest.title;
    if (!groups.includes(group)) {
      groups.push(group);
    }
    const request = requestContract(name, op, http, components);
    const sendsBody = 'requestBody' in request;
    const failures = failureResponses(name, op, sendsBody, manifest.errors.definitions, components);
    if (Object.values(failures).some((response) => 'Retry-After' in response.headers)) {
      headers.add('RetryAfter');
    }
    (paths[http.path] ??= {})[http.method.toLowerCase()] = {
      operationId: name,
      summary: op.title,
      // A route that says no more than its title documents none.
      ...(op.description ? { description: op.description } : {}),
      tags: [group],
      // Alternatives: OpenAPI admits a request that satisfies any one security requirement.
      security: operationSecurity(op, manifest.tokens),
      'x-required-scopes': [...operationScopes(op)],
      ...(operationScopes(op).length > 1 ? { 'x-scope-match': op.scopeMatch ?? 'any' } : {}),
      ...(op.conditionalScopes ? { 'x-conditional-scopes': op.conditionalScopes } : {}),
      'x-effect': op.effect,
      ...(op.mcp
        ? {
            'x-mcp-tool': op.mcp.name,
            'x-mcp-idempotent': op.mcp.idempotent,
            'x-mcp-open-world': mcpOpenWorld(op.mcp),
          }
        : {}),
      'x-native-rpc': Boolean(op.rpc),
      // The limits in force: the operation's, else the application's, else the default.
      'x-max-body-bytes': operationBodyLimit(manifest, op),
      'x-max-output-bytes': operationOutputLimit(manifest, op),
      ...(http.body ? { 'x-body': http.body, 'x-input-headers': http.headers ?? {} } : {}),
      ...(http.response ? { 'x-response': http.response } : {}),
      ...request,
      responses: {
        [http.successStatus ?? 200]: successResponse(name, op, http, components),
        ...failures,
      },
    };
  }
  for (const described of Object.keys(manifest.groups ?? {})) {
    if (!groups.includes(described)) {
      throw new TypeError(
        `groups describes "${described}", which no public route has as its group; the groups are ${groups.join(', ') || 'none'}.`
      );
    }
  }
  // A JSON round trip drops TypeBox's symbol metadata from the wire contract; JSON and YAML serve this
  // same document.
  // oxlint-disable-next-line unicorn/prefer-structured-clone
  return JSON.parse(
    JSON.stringify({
      openapi: '3.1.0',
      info: {
        title: manifest.title,
        version: manifest.version,
        ...(manifest.description ? { description: manifest.description } : {}),
      },
      servers: [{ url: manifest.origin }],
      tags: groups.map((group) => {
        const description = manifest.groups?.[group];
        return description ? { name: group, description } : { name: group };
      }),
      paths,
      components: {
        schemas: components.schemas,
        headers: Object.fromEntries([...headers].map((name) => [name, HEADERS[name]])),
        securitySchemes: securitySchemes(manifest.tokens, scopes),
      },
    })
  ) as OpenApiDocument;
}

/** A scope as people read it: `notes:notes:read` reads notes, `notes:task-lists:write` writes task lists. */
function scopeDescription(scope: string): string {
  const [namespace, resource, action, ...deeper] = scope.split(':');
  if (namespace === undefined || resource === undefined || deeper.length) {
    return scope;
  }
  const words = resource.replaceAll('-', ' ');
  if (action === 'read') {
    return `Read ${words}.`;
  }
  if (action === 'write') {
    return `Create, change and delete ${words}.`;
  }
  return scope;
}

/** Whether a body schema requires a field, so no empty body is valid: a union does when each member does. */
function requiresField(schema: unknown): boolean {
  const node = schema as { required?: unknown[]; anyOf?: unknown[] };
  return node.anyOf ? node.anyOf.every(requiresField) : (node.required ?? []).length > 0;
}

/**
 * A parameter, described on the parameter itself, where generators read it: by its schema's description, or
 * else by its name in words (`noteId` is `The note id.`).
 */
function parameter(
  name: string,
  location: 'path' | 'query' | 'header',
  required: boolean,
  schema: TSchema,
  style: object = {}
): object {
  const words = name
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll(/[_-]+/g, ' ')
    .toLowerCase();
  const description = typeof schema.description === 'string' ? schema.description : `The ${words}.`;
  return { name, in: location, required, description, ...style, schema };
}

/**
 * Where an operation's input travels: its path parameters, then a byte body's query and header
 * metadata, a GET's query, or a JSON body without the fields the path carries. A DELETE whose input the
 * path carries whole sends no body.
 */
function requestContract(
  name: string,
  op: OperationShape,
  http: NonNullable<OperationShape['http']>,
  components: ComponentSchemas
): object {
  // As callers send it: a field with a default is optional.
  const input = wireInput(op.input);
  const parameterNames = operationPathParameters(http.path);
  const pathNames = new Set(parameterNames);
  const pathParameters = parameterNames.map((pathName) => {
    const schemas = pathParameterSchemas(input, pathName);
    return parameter(
      pathName,
      'path',
      true,
      schemas.length === 1 && schemas[0] ? schemas[0] : Type.Union(schemas)
    );
  });
  const properties = (input.properties ?? {}) as Record<string, TSchema>;
  const required = (input.required ?? []) as string[];
  const fields = Object.entries(properties).filter(([field]) => !pathNames.has(field));
  if (http.body === 'bytes') {
    return {
      parameters: [
        ...pathParameters,
        ...fields.map(([field, schema]) => {
          const header = http.headers && Object.hasOwn(http.headers, field) ? http.headers[field] : undefined;
          return {
            ...parameter(header ?? field, header ? 'header' : 'query', required.includes(field), schema),
            'x-input-field': field,
          };
        }),
      ],
      requestBody: {
        required: true,
        content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
      },
    };
  }
  if (http.method === 'GET') {
    const kinds = queryKinds(op);
    return {
      parameters: [
        ...pathParameters,
        ...fields.map(([field, schema]) =>
          parameter(
            field,
            'query',
            required.includes(field),
            schema,
            // A list travels as one comma-separated value, `tags=a,b`, never as a repeated key.
            kinds.get(field) === 'list' ? { style: 'form', explode: false } : {}
          )
        ),
      ],
    };
  }
  const body = pathNames.size ? bodyWithoutPathParameters(input, pathNames) : input;
  const located = pathParameters.length ? { parameters: pathParameters } : {};
  if (http.method === 'DELETE' && isEmptyObject(body)) {
    return located;
  }
  return {
    ...located,
    requestBody: {
      // A DELETE may send no body at all, and is then its empty input: its body is required only when its
      // input requires a field the path does not carry. Any other method sends a JSON body, `{}` at least.
      required: http.method !== 'DELETE' || requiresField(body),
      content: { 'application/json': { schema: bodySchema(name, body, components) } },
    },
  };
}

/**
 * The schema of a JSON request body: `Empty` for one without fields, which still travels as `{}`; the
 * input's own when it is named and the path carries none of it; else the component `<Operation>Body`.
 */
function bodySchema(name: string, body: TSchema, components: ComponentSchemas): TSchema | SchemaReference {
  if (isEmptyObject(body)) {
    return components.add('Empty', EMPTY_OBJECT);
  }
  if (typeof body.$id === 'string') {
    return body;
  }
  return components.add(`${pascalCase(name)}Body`, body);
}

/** The success response: the JSON envelope, or a validated attachment's bytes and headers. */
function successResponse(
  name: string,
  op: OperationShape,
  http: NonNullable<OperationShape['http']>,
  components: ComponentSchemas
): object {
  const headers = { 'X-Request-Id': headerReference('RequestId') };
  if (http.response !== 'attachment') {
    return {
      description: 'Successful operation.',
      headers,
      content: { 'application/json': { schema: successSchema(name, op.output, components) } },
    };
  }
  return {
    description: 'Successful operation.',
    content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
    headers: {
      ...headers,
      'Content-Type': { schema: { type: 'string' }, description: 'Validated attachment media type.' },
      'Content-Length': {
        schema: { type: 'integer', minimum: 0 },
        description: 'Exact attachment byte length.',
      },
      'Content-Disposition': {
        schema: { type: 'string' },
        description: 'Attachment filename in ASCII and RFC 5987 UTF-8 forms.',
      },
    },
  };
}

/**
 * The component of a successful answer: named after its output's `$id` (`NoteResponse`, which every
 * operation that answers a note shares), `EmptyResponse` for an output without fields, and otherwise after
 * the operation, with its output as `<Operation>Result`.
 */
function successSchema(name: string, output: TSchema, components: ComponentSchemas): SchemaReference {
  if (isEmptyObject(output)) {
    return components.add('EmptyResponse', successEnvelope(components.add('Empty', EMPTY_OBJECT)));
  }
  const operation = pascalCase(name);
  if (typeof output.$id === 'string') {
    const envelope = successEnvelope(output);
    const named = `${output.$id}Response`;
    // Two outputs that share an `$id` but not a shape each keep an envelope of their own.
    return components.add(
      components.holdsOther(named, envelope) ? `${operation}ResultResponse` : named,
      envelope
    );
  }
  return components.add(
    `${operation}ResultResponse`,
    successEnvelope(components.add(`${operation}Result`, output))
  );
}

/** One status an operation documents: its description, headers and failure codes, and its envelope. */
interface FailureResponse {
  description: string;
  headers: Record<string, unknown>;
  'x-failure-codes': string[];
  content: { 'application/json': { schema: SchemaReference } };
}

/**
 * The failures an operation documents, one response per status, in catalog order: the standard failures
 * its route can meet, never routing's (an unknown path or method) and, when it sends no body, never a
 * body's; then the domain failures it declares, or every one when it declares none.
 */
function failureResponses(
  name: string,
  op: OperationShape,
  sendsBody: boolean,
  definitions: Readonly<Record<string, ErrorDefinition>>,
  components: ComponentSchemas
): Record<number, FailureResponse> {
  const statuses = new Map<number, ErrorDefinition[]>();
  for (const definition of Object.values(definitions)) {
    if (documentsFailure(op, sendsBody, definition.code)) {
      statuses.set(definition.status, [...(statuses.get(definition.status) ?? []), definition]);
    }
  }
  return Object.fromEntries(
    [...statuses].map(([status, failures]) => [status, failureResponse(name, status, failures, components)])
  );
}

/** Whether an operation's document lists a failure, as `failureResponses` describes. */
function documentsFailure(op: OperationShape, sendsBody: boolean, code: string): boolean {
  if (ROUTING_CODES.has(code)) {
    return false;
  }
  if (BODY_CODES.has(code)) {
    return sendsBody;
  }
  return STANDARD_CODES.has(code) || !op.failures || op.failures.includes(code);
}

/**
 * One status an operation documents: each failure as its component, and the envelope of the answer, named
 * after its code when it is the status's only one (`NoteNotFoundError`), else after the operation and the
 * status (`ListNotesBadRequestError`), whose failures a discriminator on `code` tells apart.
 */
function failureResponse(
  name: string,
  status: number,
  failures: readonly ErrorDefinition[],
  components: ComponentSchemas
): FailureResponse {
  for (const failure of failures) {
    addFailure(failure, components);
  }
  const codes = failures.map(({ code }) => code);
  const [only] = codes;
  const statusName = `${pascalCase(name)}${statusReason(status)}`;
  const envelope =
    codes.length === 1 && only !== undefined
      ? components.add(failureEnvelopeName(only), failureEnvelope(schemaReference(failureName(only))))
      : components.add(
          `${statusName}Error`,
          failureEnvelope(components.add(`${statusName}Failure`, failureUnion(codes)))
        );
  const lines = failures.map((failure) => `\`${failure.code}\`: ${failure.message}`);
  return {
    description:
      lines.length === 1 && lines[0] !== undefined ? lines[0] : lines.map((line) => `- ${line}`).join('\n'),
    headers: {
      'X-Request-Id': headerReference('RequestId'),
      ...(status === 429 || failures.some((failure) => failure.retryAfter)
        ? { 'Retry-After': headerReference('RetryAfter') }
        : {}),
    },
    'x-failure-codes': codes,
    content: { 'application/json': { schema: envelope } },
  };
}

/** A failure as its component, `<Code>Failure`, with its data: the schema its definition declares, else `Empty`. */
function addFailure(definition: ErrorDefinition, components: ComponentSchemas): void {
  const { dataSchema } = definition;
  let data: unknown;
  if (dataSchema === undefined || isEmptyObject(dataSchema)) {
    data = components.add('Empty', EMPTY_OBJECT);
  } else if (typeof dataSchema.$id === 'string') {
    data = dataSchema;
  } else {
    data = components.add(`${failureName(definition.code)}Data`, dataSchema);
  }
  components.add(failureName(definition.code), failureSchema(definition, data));
}

/**
 * The security requirements that admit an operation, any one of which is enough: its scopes as
 * OAuth requirements (all of them in one requirement when it needs all), or the application's own
 * bearer tokens. With both schemes, users present OAuth tokens and services the application's own.
 * Behind Cloudflare Access, a client presents a service token's two headers together.
 */
function operationSecurity(
  op: OperationShape,
  tokens: Pick<TokenPolicy, 'scheme' | 'source'>
): Record<string, string[]>[] {
  if (usesCloudflareAccess(tokens)) {
    return [{ accessClientId: [], accessClientSecret: [] }];
  }
  let security: Record<string, string[]>[];
  if (tokens.scheme?.type === 'bearer') {
    security = [{ bearer: [] }];
  } else if (op.scopeMatch === 'all') {
    security = [{ oauth2: [...operationScopes(op)] }];
  } else {
    security = operationScopes(op).map((scope) => ({ oauth2: [scope] }));
  }
  if (tokens.scheme?.type === 'oauth+bearer') {
    // `.build()` refuses an operation that names no eligible actors under dual authentication.
    const actors = op.actorKinds ?? [];
    if (!actors.includes('user')) {
      security = [];
    }
    if (actors.includes('service')) {
      security.push({ bearer: [] });
    }
  }
  return security;
}

/**
 * How callers obtain a token: the OAuth 2.0 flows of the issuer (authorization code, and client
 * credentials unless services use the application's own tokens), the application's own bearer
 * tokens, or both. Behind Cloudflare Access, the headers of an Access service token, which Access
 * exchanges at the edge for the application token the API verifies; people sign in to Access in a
 * browser, which no scheme describes.
 */
function securitySchemes(
  tokens: Pick<TokenPolicy, 'scheme' | 'source' | 'issuer' | 'authorizationEndpoint' | 'tokenEndpoint'>,
  scopes: Record<string, string>
): Record<string, unknown> {
  if (usesCloudflareAccess(tokens)) {
    return {
      accessClientId: {
        type: 'apiKey',
        in: 'header',
        name: 'CF-Access-Client-Id',
        description: 'The Client ID of a Cloudflare Access service token, sent with its Client Secret.',
      },
      accessClientSecret: {
        type: 'apiKey',
        in: 'header',
        name: 'CF-Access-Client-Secret',
        description: 'The Client Secret of the Cloudflare Access service token whose Client ID is sent.',
      },
    };
  }
  const { scheme } = tokens;
  if (scheme?.type === 'bearer') {
    return { bearer: { type: 'http', scheme: 'bearer', description: scheme.description } };
  }
  const { authorization, token: tokenUrl } = tokenEndpoints(tokens);
  return {
    oauth2: {
      type: 'oauth2',
      flows: {
        authorizationCode: { authorizationUrl: authorization, tokenUrl, scopes },
        ...(scheme?.type === 'oauth+bearer' ? {} : { clientCredentials: { tokenUrl, scopes } }),
      },
    },
    ...(scheme?.type === 'oauth+bearer'
      ? { bearer: { type: 'http', scheme: 'bearer', description: scheme.description } }
      : {}),
  };
}
