/**
 * The OpenAPI document: each public HTTP operation with its scopes, limits and MCP hints, its failures by
 * status and its OAuth flows, only OpenAPI's own fields at the root, and every body, answer and failure a
 * named component, as SDK generators read it.
 */
import { expect, it } from 'vite-plus/test';

import {
  createHttpHandler,
  createOpenApi,
  defineErrors,
  maximus,
  ok,
  PageQueryFields,
  t,
} from '../src/index.ts';
import type { AppManifest, OperationShape } from '../src/index.ts';
import { defaultSchema } from '../src/schemas.ts';

const ISSUER = 'https://issuer.example.test/';
const empty = t.Object({}, { additionalProperties: false });
const item = t.Object({ recordId: t.String() }, { additionalProperties: false });
const words = { title: 'Records', description: 'The organization records.' };
const errors = defineErrors({
  recordMissing: { code: 'RECORD_MISSING', status: 404, message: 'The record does not exist.' },
  recordLocked: {
    code: 'RECORD_LOCKED',
    status: 409,
    message: 'The record is locked.',
    retryable: true,
    retryAfter: 30,
  },
  quotaReached: { code: 'QUOTA_REACHED', status: 429, message: 'The record quota is reached.' },
});

function application() {
  return (
    maximus<Record<string, never>>({
      name: 'fixture',
      namespace: 'fixture',
      title: 'Fixture',
      version: '1',
      origin: 'https://fixture.example.test',
      tokens: { issuer: ISSUER, audience: 'https://fixture.example.test' },
      errors,
      rpc: { callers: [] },
      telemetry: { enabled: false },
      maxBodyBytes: 65_536,
      maxOutputBytes: 131_072,
    })
      // A route and a tool that leaves openWorld to its default, under either of two scopes. Declares one
      // domain failure.
      .operation(
        'listRecords',
        {
          ...words,
          effect: 'read',
          scope: ['fixture:records:read', 'fixture:records:write'],
          input: empty,
          output: empty,
          http: { method: 'GET', path: '/v1/records' },
          mcp: { name: 'records_list', idempotent: true },
          actorKinds: ['user', 'service'],
          failures: ['RECORD_MISSING'],
        },
        async () => ok({})
      )
      // An item operation whose tool declares that it stays inside the service.
      .operation(
        'getRecord',
        {
          ...words,
          effect: 'read',
          scope: 'fixture:records:read',
          input: item,
          output: empty,
          http: { method: 'GET', path: '/v1/records/{recordId}' },
          mcp: { name: 'records_get', idempotent: true, openWorld: false },
          actorKinds: ['user'],
        },
        async () => ok({})
      )
      // Its own limits, and a conditional scope; a route without a tool.
      .operation(
        'importRecords',
        {
          ...words,
          effect: 'write',
          scope: 'fixture:records:write',
          input: empty,
          output: empty,
          http: { method: 'POST', path: '/v1/records/import' },
          conditionalScopes: ['fixture:records:import-sensitive'],
          maxBodyBytes: 1_048_576,
          maxOutputBytes: 65_536,
          actorKinds: ['service'],
        },
        async () => ok({})
      )
      // Internal: the document names neither it nor its scope.
      .operation(
        'adjustRecord',
        {
          ...words,
          effect: 'write',
          scope: 'fixture:staff:operate',
          input: empty,
          output: empty,
          http: { method: 'POST', path: '/v1/records/adjust' },
          visibility: 'internal',
          actorKinds: ['user'],
        },
        async () => ok({})
      )
      // A tool without a route: the HTTP document has nothing to say about it.
      .operation(
        'summarizeRecords',
        {
          ...words,
          effect: 'read',
          scope: 'fixture:summaries:read',
          input: empty,
          output: empty,
          mcp: { name: 'records_summarize', idempotent: true },
          actorKinds: ['user'],
        },
        async () => ok({})
      )
      .build()
  );
}

type Json = Record<string, unknown>;
interface Document {
  tags: { name: string; description?: string }[];
  paths: Record<string, Record<string, Json>>;
  components: {
    schemas: Record<string, Json>;
    headers: Record<string, Json>;
    securitySchemes: Record<string, Json>;
  };
}
/** A response's JSON schema: a reference to its component. */
interface JsonContent {
  content: { 'application/json': { schema: { $ref: string } } };
}
/** The component a reference names. */
function componentAt(document: Document, reference: string): Json {
  const found = document.components.schemas[reference.slice('#/components/schemas/'.length)];
  if (!found) {
    throw new Error(`${reference} names no component`);
  }
  return found;
}
function operationsOf(document: Document): Json[] {
  return Object.values(document.paths).flatMap((methods) => Object.values(methods));
}
function operationNamed(document: Document, name: string): Json {
  const found = operationsOf(document).find((operation) => operation.operationId === name);
  if (!found) {
    throw new Error(`${name} is not documented`);
  }
  return found;
}
function documentOf<E, C, O extends Record<string, OperationShape>>(app: AppManifest<E, C, O>): Document {
  return createOpenApi(app) as unknown as Document;
}

it('documents each public HTTP operation with its scopes, limits and MCP hints', () => {
  const document = documentOf(application());
  // Internal operations and tools without a route stay out.
  expect(operationsOf(document).map((operation) => operation.operationId)).toEqual([
    'listRecords',
    'getRecord',
    'importRecords',
  ]);
  expect(operationNamed(document, 'listRecords')).toMatchObject({
    summary: 'Records',
    description: 'The organization records.',
    tags: ['Records'],
    security: [{ oauth2: ['fixture:records:read'] }, { oauth2: ['fixture:records:write'] }],
    'x-required-scopes': ['fixture:records:read', 'fixture:records:write'],
    'x-scope-match': 'any',
    'x-effect': 'read',
    'x-native-rpc': false,
    'x-mcp-tool': 'records_list',
    'x-mcp-idempotent': true,
    'x-mcp-open-world': true,
    'x-max-body-bytes': 65_536,
    'x-max-output-bytes': 131_072,
  });
  expect(operationNamed(document, 'getRecord')).toMatchObject({
    parameters: [{ name: 'recordId', in: 'path', required: true }],
    'x-required-scopes': ['fixture:records:read'],
    'x-mcp-tool': 'records_get',
    'x-mcp-open-world': false,
  });
  // One scope needs no match rule.
  expect(operationNamed(document, 'getRecord')).not.toHaveProperty('x-scope-match');
  expect(operationNamed(document, 'importRecords')).toMatchObject({
    'x-max-body-bytes': 1_048_576,
    'x-max-output-bytes': 65_536,
    'x-conditional-scopes': ['fixture:records:import-sensitive'],
  });
  expect(operationNamed(document, 'importRecords')).not.toHaveProperty('x-mcp-tool');
  expect(operationNamed(document, 'importRecords')).not.toHaveProperty('x-mcp-idempotent');
});

it('documents a list query field as one comma-separated value, the form the API reads', async () => {
  const app = maximus<Record<string, never>>({
    name: 'fixture',
    namespace: 'fixture',
    title: 'Fixture',
    version: '1',
    origin: 'https://fixture.example.test',
    tokens: { issuer: ISSUER, audience: 'https://fixture.example.test' },
    errors,
    rpc: { callers: [] },
    telemetry: { enabled: false },
  })
    .operation(
      'searchRecords',
      {
        ...words,
        effect: 'read',
        scope: 'fixture:records:read',
        input: t.Object(
          { tags: t.Optional(t.Array(t.String())), limit: t.Optional(t.Integer()) },
          { additionalProperties: false }
        ),
        output: t.Object({ tags: t.Array(t.String()) }, { additionalProperties: false }),
        http: { method: 'GET', path: '/v1/records/search' },
      },
      async (_context, input) => ok({ tags: input.tags ?? [] })
    )
    .build();
  const operation = (createOpenApi(app) as { paths: Record<string, { get: { parameters: object[] } }> })
    .paths['/v1/records/search'];
  // OpenAPI's default for an array would have clients repeat the key; the list's parameter says otherwise.
  expect(operation?.get.parameters).toStrictEqual([
    {
      name: 'tags',
      in: 'query',
      required: false,
      description: 'The tags.',
      style: 'form',
      explode: false,
      schema: { type: 'array', items: { type: 'string' } },
    },
    { name: 'limit', in: 'query', required: false, description: 'The limit.', schema: { type: 'integer' } },
  ]);
  const handle = createHttpHandler(app, {
    verify: async () => ({
      sub: 'client@clients',
      client_id: 'client',
      org_id: 'org_1234567890abcdef',
      scope: 'fixture:records:read',
    }),
  });
  const search = (query: string) =>
    handle(
      new Request(`https://fixture.example.test/v1/records/search?${query}`, {
        headers: { authorization: 'Bearer a.b.c' },
      }),
      {}
    );
  expect(await (await search('tags=a,b')).json()).toMatchObject({ data: { tags: ['a', 'b'] } });
  expect((await search('tags=a&tags=b')).status).toBe(400);
});

it('publishes a field with a default as optional, since decoding fills it in, whether or not inputSchema() wraps the input', () => {
  const app = maximus<Record<string, never>>({
    name: 'fixture',
    namespace: 'fixture',
    title: 'Fixture',
    version: '1',
    origin: 'https://fixture.example.test',
    tokens: { issuer: ISSUER, audience: 'https://fixture.example.test' },
    errors,
    rpc: { callers: [] },
    telemetry: { enabled: false },
  })
    .operation(
      'listRecords',
      {
        ...words,
        effect: 'read',
        scope: 'fixture:records:read',
        input: t.Object(PageQueryFields, { additionalProperties: false }),
        output: empty,
        http: { method: 'GET', path: '/v1/records' },
      },
      async () => ok({})
    )
    .operation(
      'createRecord',
      {
        ...words,
        effect: 'write',
        scope: 'fixture:records:write',
        input: t.Object(
          { title: t.String(), pinned: defaultSchema(t.Boolean(), false) },
          { additionalProperties: false }
        ),
        output: empty,
        http: { method: 'POST', path: '/v1/records' },
      },
      async () => ok({})
    )
    .build();
  const paths = (
    createOpenApi(app) as {
      paths: Record<string, { get: { parameters: { name: string; required: boolean }[] }; post: object }>;
    }
  ).paths['/v1/records'];
  expect(paths?.get.parameters.map(({ name, required }) => [name, required])).toStrictEqual([
    ['cursor', false],
    ['direction', false],
    ['limit', false],
  ]);
  expect(paths?.post).toMatchObject({
    requestBody: {
      content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateRecordBody' } } },
    },
  });
  expect((createOpenApi(app) as unknown as Document).components.schemas.CreateRecordBody).toMatchObject({
    required: ['title'],
  });
});

it('fills the default limits', () => {
  const defaults = { ...application(), maxBodyBytes: undefined, maxOutputBytes: undefined };
  expect(operationNamed(documentOf(defaults), 'listRecords')).toMatchObject({
    'x-max-body-bytes': 32_768,
    'x-max-output-bytes': 262_144,
  });
});

it("keeps the root to OpenAPI's own fields and every extension to an operation", () => {
  const document = documentOf(application());
  expect(Object.keys(document)).toEqual(['openapi', 'info', 'servers', 'tags', 'paths', 'components']);
  expect(document).toMatchObject({
    openapi: '3.1.0',
    info: { title: 'Fixture', version: '1' },
    servers: [{ url: 'https://fixture.example.test' }],
  });
  expect(JSON.stringify(document)).not.toContain('x-maximus');
});

it('lists in the OAuth flows the scopes and conditional scopes of the documented operations only', () => {
  const { flows } = documentOf(application()).components.securitySchemes.oauth2 as {
    flows: Record<string, { scopes: Json }>;
  };
  const scopes = ['fixture:records:read', 'fixture:records:write', 'fixture:records:import-sensitive'];
  for (const flow of [flows.authorizationCode, flows.clientCredentials]) {
    expect(Object.keys(flow?.scopes ?? {}).toSorted()).toEqual(scopes.toSorted());
  }
  // A service that issues its own bearer tokens publishes that scheme and no OAuth flow.
  const app = application();
  const bearer = {
    ...app,
    tokens: { ...app.tokens, scheme: { type: 'bearer' as const, description: 'A session token.' } },
  };
  expect(documentOf(bearer).components.securitySchemes).toStrictEqual({
    bearer: { type: 'http', scheme: 'bearer', description: 'A session token.' },
  });
});

it("publishes the OAuth flows at the authorization server's endpoints, Auth0's by default", () => {
  const app = application();
  /** The OAuth 2.0 flows the document publishes under a token policy. */
  const flows = (tokens: Partial<typeof app.tokens>) => {
    const document = createOpenApi({ ...app, tokens: { ...app.tokens, ...tokens } });
    return (document.components as { securitySchemes: { oauth2: { flows: Json } } }).securitySchemes.oauth2
      .flows;
  };
  expect(flows({})).toMatchObject({
    authorizationCode: { authorizationUrl: `${ISSUER}authorize`, tokenUrl: `${ISSUER}oauth/token` },
    clientCredentials: { tokenUrl: `${ISSUER}oauth/token` },
  });
  const okta = 'https://example.okta.com/oauth2/default';
  expect(
    flows({ issuer: okta, authorizationEndpoint: `${okta}/v1/authorize`, tokenEndpoint: `${okta}/v1/token` })
  ).toMatchObject({
    authorizationCode: { authorizationUrl: `${okta}/v1/authorize`, tokenUrl: `${okta}/v1/token` },
    clientCredentials: { tokenUrl: `${okta}/v1/token` },
  });
  // Relative endpoints resolve against the issuer, as jwksUri does.
  expect(flows({ authorizationEndpoint: 'oauth2/authorize', tokenEndpoint: 'oauth2/token' })).toMatchObject({
    authorizationCode: { authorizationUrl: `${ISSUER}oauth2/authorize`, tokenUrl: `${ISSUER}oauth2/token` },
  });
});

it('documents one failure response per status, naming the codes that answer with it', () => {
  const document = documentOf(application());
  const listing = operationNamed(document, 'listRecords').responses as Record<string, Json & JsonContent>;
  const reading = operationNamed(document, 'getRecord').responses as Record<string, Json & JsonContent>;
  const importing = operationNamed(document, 'importRecords').responses as Record<string, Json>;
  // Routing's own failures, an unknown path or method, never answer a documented route, and a GET sends no
  // body to be too large or of another media type.
  const standard = ['400', '401', '403', '429', '500', '502', '503', '504'];
  expect(Object.keys(listing)).toEqual(['200', ...standard, '404'].toSorted());
  expect(Object.keys(reading)).toEqual(['200', ...standard, '404', '409'].toSorted());
  expect(Object.keys(importing)).toEqual(['200', ...standard, '404', '409', '413', '415'].toSorted());
  // A status one code answers refers to that code's envelope, which every operation shares.
  expect(listing['404']).toStrictEqual({
    description: '`RECORD_MISSING`: The record does not exist.',
    headers: { 'X-Request-Id': { $ref: '#/components/headers/RequestId' } },
    'x-failure-codes': ['RECORD_MISSING'],
    content: { 'application/json': { schema: { $ref: '#/components/schemas/RecordMissingError' } } },
  });
  expect(listing['400']?.content['application/json'].schema.$ref).toBe(
    '#/components/schemas/InvalidInputError'
  );
  expect(listing['429']).toMatchObject({
    'x-failure-codes': ['RATE_LIMITED'],
    headers: { 'Retry-After': { $ref: '#/components/headers/RetryAfter' } },
  });
  // Undeclared domain failures stay out of an operation that declares its own: only RATE_LIMITED answers
  // 429 for listRecords, while getRecord, which declares none, may also answer QUOTA_REACHED.
  expect(reading['429']).toMatchObject({
    description:
      '- `RATE_LIMITED`: The request rate limit was exceeded. Try again later.\n- `QUOTA_REACHED`: The record quota is reached.',
    'x-failure-codes': ['RATE_LIMITED', 'QUOTA_REACHED'],
    content: {
      'application/json': { schema: { $ref: '#/components/schemas/GetRecordTooManyRequestsError' } },
    },
  });
  expect(document.components.schemas.GetRecordTooManyRequestsFailure).toStrictEqual({
    oneOf: [
      { $ref: '#/components/schemas/RateLimitedFailure' },
      { $ref: '#/components/schemas/QuotaReachedFailure' },
    ],
    discriminator: {
      propertyName: 'code',
      mapping: {
        RATE_LIMITED: '#/components/schemas/RateLimitedFailure',
        QUOTA_REACHED: '#/components/schemas/QuotaReachedFailure',
      },
    },
  });
  expect(reading['409']).toMatchObject({
    description: '`RECORD_LOCKED`: The record is locked.',
    headers: { 'Retry-After': { $ref: '#/components/headers/RetryAfter' } },
  });
  // Each failure is its code's component: a one-value code, a plain message and its fixed retryability.
  expect(document.components.schemas.RecordLockedFailure).toStrictEqual({
    type: 'object',
    description: 'The record is locked.',
    additionalProperties: false,
    required: ['code', 'message', 'retryable', 'data'],
    properties: {
      code: {
        type: 'string',
        enum: ['RECORD_LOCKED'],
        description: 'The failure code, stable across releases.',
      },
      message: {
        type: 'string',
        description: 'What went wrong, for people; it never contains input values.',
      },
      retryable: {
        type: 'boolean',
        enum: [true],
        description: 'Whether repeating the same request may succeed.',
      },
      data: { $ref: '#/components/schemas/Empty' },
    },
  });
  expect(document.components.schemas.RecordLockedError).toStrictEqual({
    type: 'object',
    description: 'A failed answer.',
    additionalProperties: false,
    required: ['success', 'data', 'error', 'metadata'],
    properties: {
      success: { type: 'boolean', enum: [false] },
      data: { const: null },
      error: { $ref: '#/components/schemas/RecordLockedFailure' },
      metadata: { $ref: '#/components/schemas/ResponseMetadata' },
    },
  });
  // The input issue a refused input lists is named, inside the data INVALID_INPUT declares.
  expect(document.components.schemas.InvalidInputFailure).toMatchObject({
    properties: { data: { $ref: '#/components/schemas/InvalidInputFailureData' } },
  });
  expect(JSON.stringify(document.components.schemas.InvalidInputFailureData)).toContain(
    '"$ref":"#/components/schemas/ValidationIssue"'
  );
  // Every code a response lists answers with its status, and its description names it.
  const statusOf = new Map<string, number>(
    Object.values(errors.definitions).map((failure) => [failure.code, failure.status])
  );
  for (const operation of operationsOf(document)) {
    for (const [status, response] of Object.entries(operation.responses as Record<string, Json>)) {
      if (Number(status) < 400) {
        continue;
      }
      for (const code of response['x-failure-codes'] as string[]) {
        expect(statusOf.get(code)).toBe(Number(status));
        expect(response.description).toContain(`\`${code}\``);
      }
    }
  }
});

it('names every body, answer and failure as a component, the names a generated client takes', () => {
  const document = documentOf(application());
  expect(document.tags).toStrictEqual([{ name: 'Records' }]);
  for (const operation of operationsOf(document)) {
    const responses = operation.responses as Record<string, JsonContent>;
    for (const [status, response] of Object.entries(responses)) {
      const reference = response.content['application/json'].schema.$ref;
      expect(reference, `${String(operation.operationId)} ${status}`).toMatch(
        Number(status) < 400 ? /Response$/ : /Error$/
      );
      componentAt(document, reference);
    }
    const body = operation.requestBody as JsonContent | undefined;
    if (body) {
      componentAt(document, body.content['application/json'].schema.$ref);
    }
  }
  // An answer without fields shares one envelope, whose data is the one empty object.
  expect(
    (operationNamed(document, 'listRecords').responses as Record<string, JsonContent>)['200']?.content[
      'application/json'
    ].schema.$ref
  ).toBe('#/components/schemas/EmptyResponse');
  expect(document.components.schemas.EmptyResponse).toMatchObject({
    properties: {
      success: { type: 'boolean', enum: [true] },
      data: { $ref: '#/components/schemas/Empty' },
      error: { const: null },
    },
  });
  // No field is only null, which generators turn into types of their own, and no reference has siblings
  // other than the annotations of its use.
  for (const node of schemaNodes(document)) {
    for (const field of Object.values((node.properties ?? {}) as Record<string, Json>)) {
      expect(field).not.toStrictEqual({ type: 'null' });
    }
    if (typeof node.$ref === 'string') {
      expect(
        Object.keys(node).filter(
          (key) =>
            ![
              '$ref',
              'description',
              'title',
              'default',
              'examples',
              'deprecated',
              'readOnly',
              'writeOnly',
            ].includes(key)
        )
      ).toEqual([]);
    }
  }
  // The scopes read as what they let a caller do.
  const { flows } = document.components.securitySchemes.oauth2 as { flows: Record<string, { scopes: Json }> };
  expect(flows.authorizationCode?.scopes).toStrictEqual({
    'fixture:records:read': 'Read records.',
    'fixture:records:write': 'Create, change and delete records.',
    'fixture:records:import-sensitive': 'fixture:records:import-sensitive',
  });
});

/** Every object of a value, depth first, for the checks that hold for every schema node. */
function schemaNodes(value: unknown, found: Json[] = []): Json[] {
  if (Array.isArray(value)) {
    for (const entry of value) {
      schemaNodes(entry, found);
    }
  } else if (value && typeof value === 'object') {
    found.push(value as Json);
    for (const child of Object.values(value)) {
      schemaNodes(child, found);
    }
  }
  return found;
}

/** An application of one operation, so a test can vary that operation's contract. */
function single(
  definition: Pick<OperationShape, 'effect' | 'scope' | 'input' | 'output'> & {
    http: NonNullable<OperationShape['http']>;
  },
  extra: object = {}
) {
  return maximus<Record<string, never>>({
    name: 'fixture',
    namespace: 'fixture',
    title: 'Fixture',
    version: '1',
    origin: 'https://fixture.example.test',
    tokens: { issuer: ISSUER, audience: 'https://fixture.example.test' },
    errors,
    rpc: { callers: [] },
    telemetry: { enabled: false },
    ...extra,
  })
    .operation('changeRecord', { ...words, actorKinds: ['user'], ...definition }, async () => ok({}))
    .build();
}

it('documents a body without the fields its path carries, and no body for a DELETE the path names whole', () => {
  const changed = documentOf(
    single({
      effect: 'write',
      scope: 'fixture:records:write',
      input: t.Object(
        { recordId: t.String(), title: t.Optional(t.String()), note: t.Optional(t.String()) },
        { additionalProperties: false, minProperties: 2 }
      ),
      output: empty,
      http: { method: 'PATCH', path: '/v1/records/{recordId}' },
    })
  );
  // At least one field besides the record's id, which travels in the path.
  expect(changed.components.schemas.ChangeRecordBody).toStrictEqual({
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: { title: { type: 'string' }, note: { type: 'string' } },
    required: [],
  });
  const removed = documentOf(
    single({
      effect: 'delete',
      scope: 'fixture:records:write',
      input: item,
      output: empty,
      http: { method: 'DELETE', path: '/v1/records/{recordId}' },
    })
  );
  expect(operationNamed(removed, 'changeRecord')).not.toHaveProperty('requestBody');
  // Without a body, a request cannot be too large or of another media type.
  expect(operationNamed(removed, 'changeRecord').responses).not.toHaveProperty('413');
  expect(operationNamed(removed, 'changeRecord').responses).not.toHaveProperty('415');
  // An action the path names whole still sends its JSON body, `{}`.
  const archived = documentOf(
    single({
      effect: 'write',
      scope: 'fixture:records:write',
      input: item,
      output: empty,
      http: { method: 'POST', path: '/v1/records/{recordId}/archive' },
    })
  );
  expect(operationNamed(archived, 'changeRecord').requestBody).toStrictEqual({
    required: true,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Empty' } } },
  });
});

it('describes the service and each group it lists, and refuses a description of a group no route has', () => {
  const read = {
    effect: 'read' as const,
    scope: 'fixture:records:read',
    input: empty,
    output: empty,
    http: { method: 'GET' as const, path: '/v1/records' },
  };
  const described = documentOf(
    single(read, { description: 'Records of the organization.', groups: { Records: 'The records.' } })
  ) as Document & { info: Json };
  expect(described.info).toStrictEqual({
    title: 'Fixture',
    version: '1',
    description: 'Records of the organization.',
  });
  expect(described.tags).toStrictEqual([{ name: 'Records', description: 'The records.' }]);
  expect(() => documentOf(single(read, { groups: { Recrods: 'The records.' } }))).toThrow(
    'groups describes "Recrods", which no public route has as its group; the groups are Records.'
  );
});

it('refuses a schema name the document gives its own components, or a generated client its own types', () => {
  const named = t.Object(
    { recordId: t.String() },
    { $id: 'RecordMissingError', additionalProperties: false }
  );
  expect(() =>
    documentOf(
      single({
        effect: 'read',
        scope: 'fixture:records:read',
        input: empty,
        output: named,
        http: { method: 'GET', path: '/v1/records' },
      })
    )
  ).toThrow(
    'The schema $id "RecordMissingError" is the name of a component the OpenAPI document writes for its bodies, answers or failures; rename the schema.'
  );
  const generated = t.Object(
    { recordId: t.String() },
    { $id: 'ChangeRecordResponse', additionalProperties: false }
  );
  expect(() =>
    documentOf(
      single({
        effect: 'read',
        scope: 'fixture:records:read',
        input: empty,
        output: generated,
        http: { method: 'GET', path: '/v1/records' },
      })
    )
  ).toThrow(
    'The OpenAPI component ChangeRecordResponse takes the name a generated client gives operation "changeRecord"\'s own types; rename the schema or the operation.'
  );
});

it('bundles a recursive $id schema into a local component, in the built and the served document', async () => {
  // As a service's bounded JSON value: TypeBox names it with its `$id` and refers to it by that name.
  const value = t.Recursive(
    (Self) =>
      t.Union([
        t.String({ maxLength: 64 }),
        t.Number(),
        t.Boolean(),
        t.Null(),
        t.Array(Self, { maxItems: 8 }),
        t.Record(t.String(), Self, { maxProperties: 8 }),
      ]),
    { $id: 'JsonValue', description: 'A bounded JSON value.' }
  );
  // A service spreads it to describe one use, optional or not, and nests it in another named schema.
  const condition = t.Recursive(
    (Self) =>
      t.Union([
        t.Object({ all: t.Array(Self, { maxItems: 8 }) }, { additionalProperties: false }),
        t.Object(
          { path: t.String(), value: { ...t.Optional(value), description: 'The compared value.' } },
          { additionalProperties: false }
        ),
      ]),
    { $id: 'Condition' }
  );
  const setting = t.Object(
    {
      value,
      fallback: { ...value, description: 'The value used when none is set.' },
      when: t.Optional(condition),
    },
    { additionalProperties: false }
  );
  const app = maximus<Record<string, never>>({
    name: 'fixture',
    namespace: 'fixture',
    title: 'Fixture',
    version: '1',
    origin: 'https://fixture.example.test',
    tokens: { issuer: ISSUER, audience: 'https://fixture.example.test' },
    errors,
    rpc: { callers: [] },
    telemetry: { enabled: false },
  })
    .operation(
      'createSetting',
      {
        ...words,
        effect: 'write',
        scope: 'fixture:settings:write',
        input: setting,
        output: setting,
        http: { method: 'POST', path: '/v1/settings' },
        actorKinds: ['user'],
      },
      async () => ok({ value: null, fallback: null })
    )
    .operation(
      'listSettings',
      {
        ...words,
        effect: 'read',
        input: empty,
        scope: 'fixture:settings:read',
        output: t.Object({ values: t.Array(value) }, { additionalProperties: false }),
        http: { method: 'GET', path: '/v1/settings' },
        actorKinds: ['user'],
      },
      async () => ok({ values: [] })
    )
    .build();
  const served = await createHttpHandler(app)(new Request('https://fixture.example.test/openapi.json'), {});
  expect(served.status).toBe(200);
  const documents: [string, Document][] = [
    ['built', documentOf(app)],
    ['served', (await served.json()) as Document],
  ];
  const component = {
    anyOf: [
      { type: 'string', maxLength: 64 },
      { type: 'number' },
      { type: 'boolean' },
      { type: 'null' },
      { type: 'array', items: { $ref: '#/components/schemas/JsonValue' }, maxItems: 8 },
      {
        type: 'object',
        patternProperties: { '^(.*)$': { $ref: '#/components/schemas/JsonValue' } },
        maxProperties: 8,
      },
    ],
  };
  for (const [source, document] of documents) {
    // Every reference names a component of the document itself, and no `$id` is left to resolve.
    for (const reference of references(document)) {
      const [, section = '', name = ''] = /^#\/components\/(schemas|headers)\/(.+)$/.exec(reference) ?? [];
      expect(document.components[section as 'schemas' | 'headers'], `${source} ${reference}`).toHaveProperty(
        name
      );
    }
    expect(JSON.stringify(document), source).not.toContain('"$id"');
    expect(document.components.schemas.JsonValue, source).toStrictEqual(component);
    // Each use site keeps its own description beside the reference, spread or not.
    expect(operationNamed(document, 'createSetting'), source).toMatchObject({
      requestBody: {
        content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateSettingBody' } } },
      },
    });
    expect(document.components.schemas.CreateSettingBody, source).toMatchObject({
      properties: {
        value: { $ref: '#/components/schemas/JsonValue', description: 'A bounded JSON value.' },
        fallback: {
          $ref: '#/components/schemas/JsonValue',
          description: 'The value used when none is set.',
        },
        when: { $ref: '#/components/schemas/Condition' },
      },
    });
    expect(document.components.schemas.Condition, source).toMatchObject({
      anyOf: [
        { properties: { all: { items: { $ref: '#/components/schemas/Condition' } } } },
        {
          properties: {
            value: { $ref: '#/components/schemas/JsonValue', description: 'The compared value.' },
          },
        },
      ],
    });
  }
});

function references(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) {
      references(entry, found);
    }
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref' && typeof child === 'string') {
        found.push(child);
      } else {
        references(child, found);
      }
    }
  }
  return found;
}

it('bundles schemas in adapter operation extensions with the native document', () => {
  const schema = t.Recursive((self) => t.Object({ value: t.String(), children: t.Array(self) }), {
    $id: 'ExtensionTree',
  });
  const document = createOpenApi(application(), {
    operationExtensions: (name) => ({ 'x-owner-name': name, 'x-owner-input': schema }),
  });
  const found = references(document);
  expect(found).toContain('#/components/schemas/ExtensionTree');
  expect(found.every((reference) => /^#\/components\/(schemas|headers)\//.test(reference))).toBe(true);
  expect(JSON.stringify(schema)).toContain('"$id":"ExtensionTree"');
});
