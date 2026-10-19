/**
 * The OpenAPI document: each public HTTP operation with its scopes, limits and MCP hints, its failures by
 * status and its OAuth flows, and only OpenAPI's own fields at the root.
 */
import { expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import { createHttpHandler, createOpenApi, defineErrors, maximus, ok, t } from '../src/index.ts';
import type { AppManifest, OperationShape } from '../src/index.ts';

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
      // Internal: routed and scope-checked, but no document names it or its scope.
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
  paths: Record<string, Record<string, Json>>;
  components: { schemas: Record<string, Json>; securitySchemes: Record<string, Json> };
}
interface Narrowed {
  $ref: string;
  properties: { error: { properties: { code: { enum: string[] } } } };
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
    tags: ['listRecords'],
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

it('fills the default limits', () => {
  const defaults = { ...application(), maxBodyBytes: undefined, maxOutputBytes: undefined };
  expect(operationNamed(documentOf(defaults), 'listRecords')).toMatchObject({
    'x-max-body-bytes': 32_768,
    'x-max-output-bytes': 262_144,
  });
});

it("keeps the root to OpenAPI's own fields and every extension to an operation", () => {
  const document = documentOf(application());
  expect(Object.keys(document)).toEqual(['openapi', 'info', 'servers', 'paths', 'components']);
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

it('documents one failure response per status, naming the codes that answer with it', async () => {
  const app = application();
  const document = documentOf(app);
  const listing = operationNamed(document, 'listRecords').responses as Record<string, Json>;
  const reading = operationNamed(document, 'getRecord').responses as Record<string, Json>;
  const standard = ['400', '401', '403', '404', '405', '413', '415', '429', '500', '502', '503', '504'];
  expect(Object.keys(listing)).toEqual(['200', ...standard]);
  expect(Object.keys(reading)).toEqual(['200', ...standard, '409'].toSorted());
  const narrowed = (codes: string[]): Narrowed => ({
    $ref: '#/components/schemas/FailureResponse',
    properties: { error: { properties: { code: { enum: codes } } } },
  });
  expect(listing['404']).toMatchObject({
    description:
      '- `NOT_FOUND`: The requested operation does not exist.\n- `RECORD_MISSING`: The record does not exist.',
    content: { 'application/json': { schema: narrowed(['NOT_FOUND', 'RECORD_MISSING']) } },
  });
  expect(listing['400']).toMatchObject({
    description: '`INVALID_INPUT`: The request does not match the published schema.',
    content: { 'application/json': { schema: narrowed(['INVALID_INPUT']) } },
  });
  expect(listing['400']?.headers).not.toHaveProperty('Retry-After');
  // Undeclared domain failures stay out: only RATE_LIMITED answers 429 here.
  expect(listing['429']).toMatchObject({
    content: { 'application/json': { schema: narrowed(['RATE_LIMITED']) } },
    headers: { 'Retry-After': { schema: { type: 'integer' } } },
  });
  expect(reading['429']).toMatchObject({
    content: { 'application/json': { schema: narrowed(['RATE_LIMITED', 'QUOTA_REACHED']) } },
  });
  expect(reading['409']).toMatchObject({
    description: '`RECORD_LOCKED`: The record is locked.',
    headers: { 'Retry-After': { schema: { type: 'integer' } } },
  });

  // Every code a status names answers with that status, and FailureResponse stays the whole catalog.
  const statusOf = new Map<string, number>(
    Object.values(errors.definitions).map((failure) => [failure.code, failure.status])
  );
  for (const operation of operationsOf(document)) {
    for (const [status, response] of Object.entries(operation.responses as Record<string, Json>)) {
      if (Number(status) < 400) {
        continue;
      }
      const { schema } = (response.content as Record<'application/json', { schema: Narrowed }>)[
        'application/json'
      ];
      expect(schema.$ref).toBe('#/components/schemas/FailureResponse');
      for (const code of schema.properties.error.properties.code.enum) {
        expect(statusOf.get(code)).toBe(Number(status));
        expect(response.description).toContain(`\`${code}\``);
      }
    }
  }
  // The whole catalog, beside the Failure base each code's variant narrows; its input issue is named.
  const failureResponse = document.components.schemas.FailureResponse as { properties: Json };
  const issue = JSON.stringify({ $ref: '#/components/schemas/ValidationIssue' });
  const resolved = JSON.stringify(failureResponse.properties.error).replace(
    issue,
    JSON.stringify(document.components.schemas.ValidationIssue)
  );
  expect(JSON.parse(resolved)).toStrictEqual({
    allOf: [{ $ref: '#/components/schemas/Failure' }],
    ...JSON.parse(JSON.stringify(errors.schema, (key, value) => (key === '$id' ? undefined : value))),
  });
  expect(parse(stringify(document))).toStrictEqual(document);
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
      expect(reference, source).toMatch(/^#\/components\/schemas\//);
      expect(document.components.schemas, source).toHaveProperty(
        reference.slice('#/components/schemas/'.length)
      );
    }
    expect(JSON.stringify(document), source).not.toContain('"$id"');
    expect(document.components.schemas.JsonValue, source).toStrictEqual(component);
    // Each use site keeps its own description beside the reference, spread or not.
    expect(operationNamed(document, 'createSetting'), source).toMatchObject({
      requestBody: {
        content: {
          'application/json': {
            schema: {
              properties: {
                value: { $ref: '#/components/schemas/JsonValue', description: 'A bounded JSON value.' },
                fallback: {
                  $ref: '#/components/schemas/JsonValue',
                  description: 'The value used when none is set.',
                },
                when: { $ref: '#/components/schemas/Condition' },
              },
            },
          },
        },
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
  expect(found.every((reference) => reference.startsWith('#/components/schemas/'))).toBe(true);
  expect(JSON.stringify(schema)).toContain('"$id":"ExtensionTree"');
});
