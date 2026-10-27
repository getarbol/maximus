/**
 * An application's OpenAPI 3.1 document, as its origin serves it: paths, response envelopes, failures by
 * status, security schemes, and the `x-*` extensions that carry what OpenAPI cannot say (scopes, effects,
 * limits, MCP tools and native RPC).
 */
import { Type } from '@sinclair/typebox';
import type { TSchema } from '@sinclair/typebox';

import { FailureSchema } from './errors.ts';
import type { ErrorDefinition } from './errors.ts';
import { operationPathParameters } from './http-paths.ts';
import { pathParameterSchemas } from './internal/http-routes.ts';
import {
  STANDARD_CODES,
  isPublicOperation,
  mcpOpenWorld,
  operationBodyLimit,
  operationOutputLimit,
  operationScopes,
} from './manifest.ts';
import type { AppManifest, OperationShape } from './manifest.ts';
import { bundleSchemas } from './schema-bundle.ts';
import { tokenEndpoints } from './tokens.ts';
import type { TokenPolicy } from './tokens.ts';

/** OpenAPI body ownership excludes fields carried by the path, including each union variant. */
function bodyWithoutPathParameters(input: TSchema, names: ReadonlySet<string>): unknown {
  if (input.type === 'object') {
    return {
      ...input,
      properties: Object.fromEntries(Object.entries(input.properties).filter(([name]) => !names.has(name))),
      required: (input.required ?? []).filter((name: string) => !names.has(name)),
    };
  }
  return {
    ...input,
    anyOf: input.anyOf.map((schema: TSchema) => bodyWithoutPathParameters(schema, names)),
  };
}

/**
 * One status an operation documents: the failure codes that answer with it, each with its message, and
 * `FailureResponse` narrowed to them (`error.code` among them, beside the reference, as JSON Schema
 * 2020-12 allows). `FailureResponse` itself stays whole, so a reader that ignores the narrowing still
 * meets the complete catalog.
 */
function failureResponse(status: number, failures: readonly ErrorDefinition[]) {
  const lines = failures.map((failure) => `\`${failure.code}\`: ${failure.message}`);
  return {
    description: lines.length === 1 ? lines[0] : lines.map((line) => `- ${line}`).join('\n'),
    headers: {
      'X-Request-Id': { schema: { type: 'string' }, description: 'Request correlation identifier.' },
      ...(status === 429 || failures.some((failure) => failure.retryAfter)
        ? {
            'Retry-After': {
              schema: { type: 'integer' },
              description: 'Seconds before another attempt.',
            },
          }
        : {}),
    },
    content: {
      'application/json': {
        schema: {
          $ref: '#/components/schemas/FailureResponse',
          properties: { error: { properties: { code: { enum: failures.map((failure) => failure.code) } } } },
        },
      },
    },
  };
}

/** An OpenAPI document as Maximus writes it: JSON, with its paths, component schemas and extensions. */
export interface OpenApiDocument {
  [key: string]: unknown;
  /** The OpenAPI `paths` object: each route template, with its operation under the lowercase HTTP method. */
  paths: unknown;
  /**
   * The OpenAPI `components` object: the named `schemas`, such as `FailureResponse`, and the
   * `securitySchemes`.
   */
  components: { [key: string]: unknown; schemas: Record<string, unknown> };
}

/**
 * The document the origin serves at `/openapi.json`: every public operation that declares an HTTP route,
 * never an internal one. Each operation also carries its scopes, effect, limits in force, MCP tool hints
 * and native RPC as `x-*` extensions.
 *
 * Every schema reference in it is a local `#/components/schemas/<name>` pointer: the `$id`-named
 * schemas of its paths and components (TypeBox Recursive/Ref) become components, as `bundleSchemas`
 * describes.
 */
export function createOpenApi<E, C, O extends Record<string, OperationShape>>(
  manifest: AppManifest<E, C, O>,
  options?: {
    /** Adapter-owned operation metadata; schemas in extensions share the document's components. */
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
  const bundled = bundleSchemas(
    [document.paths, ...own.map(([, schema]) => schema)],
    document.components.schemas
  );
  const [paths, ...schemas] = bundled.values;
  return {
    ...document,
    paths,
    components: {
      ...document.components,
      schemas: {
        ...Object.fromEntries(own.map(([name], index) => [name, schemas[index]])),
        ...bundled.components,
      },
    },
  };
}

/** The document `createOpenApi` builds, before its schemas are bundled. */
function openApiDocument<E, C, O extends Record<string, OperationShape>>(
  manifest: AppManifest<E, C, O>
): OpenApiDocument {
  // Each public operation that declares a route, with that route.
  const entries = Object.entries(manifest.operations).flatMap(([name, op]) =>
    op.http && isPublicOperation(op) ? [[name, op, op.http] as const] : []
  );
  const scopes = Object.fromEntries(
    entries.flatMap(([, op]) =>
      [...operationScopes(op), ...(op.conditionalScopes ?? [])].map((scope) => [scope, scope])
    )
  );
  // Named, so the document carries the envelope's metadata once, as a component every response shares.
  const metadata = Type.Object(
    { requestId: Type.String({ description: 'Request correlation identifier, also sent as X-Request-Id.' }) },
    { $id: 'ResponseMetadata', additionalProperties: false }
  );
  // Each code's failure, and the base every one narrows, which every service's document shares.
  const failureError = { allOf: [FailureSchema], ...manifest.errors.schema };
  const failure = Type.Object(
    { success: Type.Literal(false), data: Type.Null(), error: failureError, metadata },
    { additionalProperties: false }
  );
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [name, op, http] of entries) {
    const response = Type.Object(
      { success: Type.Literal(true), data: op.output, error: Type.Null(), metadata },
      { additionalProperties: false }
    );
    (paths[http.path] ??= {})[http.method.toLowerCase()] = {
      operationId: name,
      summary: op.title,
      // A route that says no more than its title documents none.
      ...(op.description ? { description: op.description } : {}),
      // Alternatives: OpenAPI admits a request that satisfies any one security requirement.
      security: operationSecurity(op, manifest.tokens),
      tags: [op.group ?? name],
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
      ...requestContract(op.input, http),
      responses: {
        [http.successStatus ?? 200]: successResponse(http, response),
        ...failureResponses(op, manifest.errors.definitions),
      },
    };
  }
  // A JSON round trip drops TypeBox's symbol metadata from the wire contract; JSON and YAML serve this
  // same document.
  // oxlint-disable-next-line unicorn/prefer-structured-clone
  return JSON.parse(
    JSON.stringify({
      openapi: '3.1.0',
      info: { title: manifest.title, version: manifest.version },
      servers: [{ url: manifest.origin }],
      paths,
      components: {
        schemas: { FailureResponse: failure },
        securitySchemes: securitySchemes(manifest.tokens, scopes),
      },
    })
  ) as OpenApiDocument;
}

/**
 * Where an operation's input travels: its path parameters, then a byte body's query and header
 * metadata, a GET's query, or a JSON body without the fields the path carries.
 */
function requestContract(input: TSchema, http: NonNullable<OperationShape['http']>): object {
  const parameterNames = operationPathParameters(http.path);
  const pathNames = new Set(parameterNames);
  const pathParameters = parameterNames.map((parameter) => {
    const schemas = pathParameterSchemas(input, parameter);
    return {
      name: parameter,
      in: 'path',
      required: true,
      schema: schemas.length === 1 ? schemas[0] : Type.Union(schemas),
    };
  });
  const properties = (input.properties ?? {}) as Record<string, unknown>;
  const required = (input.required ?? []) as string[];
  const fields = Object.entries(properties).filter(([field]) => !pathNames.has(field));
  if (http.body === 'bytes') {
    return {
      parameters: [
        ...pathParameters,
        ...fields.map(([field, schema]) => ({
          name: http.headers?.[field] ?? field,
          in: http.headers && Object.hasOwn(http.headers, field) ? 'header' : 'query',
          required: required.includes(field),
          schema,
          'x-input-field': field,
        })),
      ],
      requestBody: {
        required: true,
        content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
      },
    };
  }
  if (http.method === 'GET') {
    return {
      parameters: [
        ...pathParameters,
        ...fields.map(([field, schema]) => ({
          name: field,
          in: 'query',
          required: required.includes(field),
          schema,
        })),
      ],
    };
  }
  return {
    ...(pathParameters.length ? { parameters: pathParameters } : {}),
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: pathNames.size ? bodyWithoutPathParameters(input, pathNames) : input,
        },
      },
    },
  };
}

/** The success response: the JSON envelope, or a validated attachment's bytes and headers. */
function successResponse(http: NonNullable<OperationShape['http']>, envelope: TSchema): object {
  if (http.response !== 'attachment') {
    return { description: 'Successful operation.', content: { 'application/json': { schema: envelope } } };
  }
  return {
    description: 'Successful operation.',
    content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
    headers: {
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
 * The failures an operation documents, one response per status naming every code that answers with
 * it, in catalog order: the standard ones and, when it declares `failures`, only those of its own.
 */
function failureResponses(
  op: OperationShape,
  definitions: Readonly<Record<string, ErrorDefinition>>
): Record<number, unknown> {
  const statuses = new Map<number, ErrorDefinition[]>();
  for (const error of Object.values(definitions)) {
    if (!op.failures || STANDARD_CODES.has(error.code) || op.failures.includes(error.code)) {
      statuses.set(error.status, [...(statuses.get(error.status) ?? []), error]);
    }
  }
  return Object.fromEntries(
    [...statuses].map(([status, failures]) => [status, failureResponse(status, failures)])
  );
}

/**
 * The security requirements that admit an operation, any one of which is enough: its scopes as
 * OAuth requirements (all of them in one requirement when it needs all), or the application's own
 * bearer tokens. With both schemes, users present OAuth tokens and services the application's own.
 */
function operationSecurity(
  op: OperationShape,
  tokens: Pick<TokenPolicy, 'scheme'>
): Record<string, string[]>[] {
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
 * tokens, or both.
 */
function securitySchemes(
  tokens: Pick<TokenPolicy, 'scheme' | 'issuer' | 'authorizationEndpoint' | 'tokenEndpoint'>,
  scopes: Record<string, string>
): Record<string, unknown> {
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
