/**
 * The OpenAPI document beyond plain JSON routes: a union body whose variants share a path parameter, a
 * byte upload's header and query parameters, an attachment response, all-of scope requirements, dual OAuth
 * and bearer authentication chosen by actor kind, and adapter extensions held to `x-` names.
 */
import { expect, it } from 'vite-plus/test';

import { AttachmentOutputSchema, createOpenApi, defineErrors, maximus, ok, t } from '../../src/index.ts';
import type { ApplicationConfiguration, TokenScheme } from '../../src/index.ts';

type Env = Record<string, never>;
type Json = Record<string, unknown>;
const strict = { additionalProperties: false } as const;
const ISSUER = 'https://issuer.example.test/';
const configuration: ApplicationConfiguration<Env> = {
  name: 'files',
  namespace: 'files',
  title: 'Files',
  version: '1',
  origin: 'https://files.example.test',
  tokens: { issuer: ISSUER, audience: 'https://files.example.test' },
  errors: defineErrors({}),
  rpc: { callers: [] },
  telemetry: { enabled: false },
};
const words = { title: 'Files', description: 'The organization files.' };
const done = t.Object({ fileId: t.String() }, strict);
/** No case runs a handler. */
const answer = (async () => ok({})) as never;

/** The document of an application with these operations, under `scheme` when one is given. */
function documentOf(operations: Record<string, object>, scheme?: TokenScheme) {
  const base = maximus<Env>({
    ...configuration,
    tokens: { ...configuration.tokens, ...(scheme ? { scheme } : {}) },
  });
  let builder = base;
  for (const [name, definition] of Object.entries(operations)) {
    builder = builder.operation(name as never, definition as never, answer) as unknown as typeof base;
  }
  return createOpenApi(builder.build()) as { paths: Record<string, Record<string, Json>>; components: Json };
}

/** The documented operation `name`. */
function operationNamed(document: ReturnType<typeof documentOf>, name: string): Json {
  const found = Object.values(document.paths)
    .flatMap((methods) => Object.values(methods))
    .find((operation) => operation.operationId === name);
  if (!found) {
    throw new Error(`${name} is not documented`);
  }
  return found;
}

it('documents a union body without the path parameter its variants share, which travels in the path', () => {
  const channelId = t.String({ pattern: '^ch_[a-z0-9]+$' });
  const Notice = t.Union([
    t.Object({ channelId, kind: t.Literal('email'), address: t.String({ format: 'email' }) }, strict),
    t.Object({ channelId, kind: t.Literal('sms'), phone: t.String() }, strict),
  ]);
  const document = documentOf({
    sendNotice: {
      ...words,
      effect: 'write',
      scope: 'files:notices:write',
      input: Notice,
      output: done,
      http: { method: 'POST', path: '/v1/channels/{channelId}/notices' },
    },
  });
  const operation = operationNamed(document, 'sendNotice');
  const pathSchema = { type: 'string', pattern: '^ch_[a-z0-9]+$' };
  // Each variant declares the parameter; the path admits what any of them does.
  expect(operation.parameters).toEqual([
    { name: 'channelId', in: 'path', required: true, schema: { anyOf: [pathSchema, pathSchema] } },
  ]);
  const body = (operation.requestBody as { content: Record<string, { schema: { anyOf: Json[] } }> }).content[
    'application/json'
  ]?.schema;
  expect(body?.anyOf).toEqual([
    {
      type: 'object',
      properties: { kind: { type: 'string', const: 'email' }, address: { type: 'string', format: 'email' } },
      required: ['kind', 'address'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { kind: { type: 'string', const: 'sms' }, phone: { type: 'string' } },
      required: ['kind', 'phone'],
      additionalProperties: false,
    },
  ]);
});

it('documents a byte upload: its header and query fields as parameters and an octet-stream body', () => {
  const binary = {
    required: true,
    content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
  };
  const document = documentOf({
    uploadFile: {
      ...words,
      effect: 'write',
      scope: 'files:files:write',
      input: t.Object({ folderId: t.String(), filename: t.String(), note: t.Optional(t.String()) }, strict),
      output: done,
      http: {
        method: 'POST',
        path: '/v1/folders/{folderId}/files',
        body: 'bytes',
        headers: { filename: 'X-Filename' },
      },
    },
    importFiles: {
      ...words,
      effect: 'write',
      scope: 'files:files:write',
      input: t.Object({ format: t.Union([t.Literal('csv'), t.Literal('tsv')]) }, strict),
      output: done,
      http: { method: 'POST', path: '/v1/imports', body: 'bytes' },
      maxBodyBytes: 1_048_576,
    },
  });
  expect(operationNamed(document, 'uploadFile')).toMatchObject({
    parameters: [
      { name: 'folderId', in: 'path', required: true, schema: { type: 'string' } },
      {
        name: 'X-Filename',
        in: 'header',
        required: true,
        schema: { type: 'string' },
        'x-input-field': 'filename',
      },
      { name: 'note', in: 'query', required: false, schema: { type: 'string' }, 'x-input-field': 'note' },
    ],
    requestBody: binary,
    'x-body': 'bytes',
    'x-input-headers': { filename: 'X-Filename' },
  });
  // Without declared headers, every field travels in the query.
  expect(operationNamed(document, 'importFiles')).toMatchObject({
    parameters: [
      {
        name: 'format',
        in: 'query',
        required: true,
        schema: { anyOf: [{ const: 'csv' }, { const: 'tsv' }] },
        'x-input-field': 'format',
      },
    ],
    requestBody: binary,
    'x-body': 'bytes',
    'x-input-headers': {},
    'x-max-body-bytes': 1_048_576,
  });
});

it('documents an attachment response as bytes with its media type, exact length and filename headers', () => {
  const download = operationNamed(
    documentOf({
      downloadFile: {
        ...words,
        effect: 'read',
        scope: 'files:files:read',
        input: t.Object({ fileId: t.String() }, strict),
        output: AttachmentOutputSchema,
        http: { method: 'GET', path: '/v1/files/{fileId}', response: 'attachment' },
      },
    }),
    'downloadFile'
  );
  expect(download['x-response']).toBe('attachment');
  expect(download).not.toHaveProperty('x-body');
  expect(download).not.toHaveProperty('requestBody');
  expect((download.responses as Record<string, Json>)['200']).toEqual({
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
  });
});

it('requires every scope in one OAuth requirement when an operation needs all of them', () => {
  const scope = ['files:files:read', 'files:audit:read'];
  const definition = {
    ...words,
    effect: 'read',
    scope,
    input: t.Object({}, strict),
    output: done,
    http: { method: 'POST', path: '/v1/files/audit' },
  };
  expect(
    operationNamed(documentOf({ auditFiles: { ...definition, scopeMatch: 'all' } }), 'auditFiles')
  ).toMatchObject({
    security: [{ oauth2: scope }],
    'x-required-scopes': scope,
    'x-scope-match': 'all',
  });
  // Any one of them is the default, one requirement each.
  expect(operationNamed(documentOf({ auditFiles: definition }), 'auditFiles')).toMatchObject({
    security: [{ oauth2: ['files:files:read'] }, { oauth2: ['files:audit:read'] }],
    'x-scope-match': 'any',
  });
});

it('under dual authentication, documents OAuth for users and the bearer scheme for services', () => {
  const scheme = { type: 'oauth+bearer', description: 'A workload key issued in the console.' } as const;
  const route = (path: string) => ({
    ...words,
    effect: 'read',
    scope: 'files:files:read',
    input: t.Object({}, strict),
    output: done,
    http: { method: 'POST', path },
  });
  const document = documentOf(
    {
      listMine: { ...route('/v1/files/mine'), actorKinds: ['user'] },
      syncFiles: { ...route('/v1/files/sync'), actorKinds: ['service'] },
      listFiles: { ...route('/v1/files/list'), actorKinds: ['user', 'service'] },
    },
    scheme
  );
  expect(operationNamed(document, 'listMine').security).toEqual([{ oauth2: ['files:files:read'] }]);
  expect(operationNamed(document, 'syncFiles').security).toEqual([{ bearer: [] }]);
  expect(operationNamed(document, 'listFiles').security).toEqual([
    { oauth2: ['files:files:read'] },
    { bearer: [] },
  ]);
  // Users sign in through the authorization code flow; services present the application's own tokens.
  expect((document.components as { securitySchemes: Json }).securitySchemes).toEqual({
    oauth2: {
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: `${ISSUER}authorize`,
          tokenUrl: `${ISSUER}oauth/token`,
          scopes: { 'files:files:read': 'files:files:read' },
        },
      },
    },
    bearer: { type: 'http', scheme: 'bearer', description: 'A workload key issued in the console.' },
  });
  // An operation that names no eligible actor cannot be documented under two schemes.
  expect(() => documentOf({ listFiles: route('/v1/files/list') }, scheme)).toThrow(
    new TypeError('Operation "listFiles": dual authentication requires explicit actor eligibility.')
  );
});

it('refuses adapter extensions that are not x- names, which would overwrite OpenAPI fields', () => {
  const base = maximus<Env>(configuration);
  const app = base
    .operation(
      'listFiles',
      {
        ...words,
        effect: 'read',
        scope: 'files:files:read',
        input: t.Object({}, strict),
        output: done,
        http: { method: 'POST', path: '/v1/files/list' },
      },
      answer
    )
    .build();
  for (const extensions of [{ summary: 'Replaced.' }, { 'x-owner': 'files', security: [] }]) {
    expect(() =>
      createOpenApi(app, { operationExtensions: () => extensions as Record<`x-${string}`, unknown> })
    ).toThrow(new TypeError('OpenAPI extensions must use x- names.'));
  }
  const extended = createOpenApi(app, { operationExtensions: (name) => ({ 'x-owner': name }) });
  expect(operationNamed(extended as ReturnType<typeof documentOf>, 'listFiles')).toMatchObject({
    summary: 'Files',
    'x-owner': 'listFiles',
  });
});
