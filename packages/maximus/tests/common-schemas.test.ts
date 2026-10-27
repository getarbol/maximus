/**
 * The shared named schemas: each one appears once as a component and validates what its name promises.
 */
import { expect, it } from 'vite-plus/test';

import {
  DeletedObjectSchema,
  EmailAddressSchema,
  FailureSchema,
  HexColorSchema,
  HttpsUrlSchema,
  NamedReferenceSchema,
  OrganizationIdSchema,
  Page,
  PageQueryFields,
  PhoneNumberSchema,
  PostalAddressSchema,
  SignedUrlSchema,
  UuidSchema,
  createOpenApi,
  defineErrors,
  maximus,
  ok,
  parseInput,
  t,
} from '../src/index.ts';
import type { TSchema } from '../src/index.ts';
import { inputSchema } from '../src/schemas.ts';

// The values and objects every service publishes alike are components of one name, so a document, and
// every SDK generated from it, has one type for each.

const Contact = t.Object(
  {
    contactId: UuidSchema,
    organizationId: OrganizationIdSchema,
    email: EmailAddressSchema,
    phone: t.Union([PhoneNumberSchema, t.Null()]),
    website: HttpsUrlSchema,
    color: HexColorSchema,
    address: PostalAddressSchema,
    owner: NamedReferenceSchema,
    photo: { ...SignedUrlSchema, description: 'The contact photo.' },
  },
  { $id: 'Contact', additionalProperties: false }
);
const words = { title: 'Contacts', description: 'The organization contacts.' };

function application() {
  return maximus<Record<string, never>>({
    name: 'fixture',
    namespace: 'fixture',
    title: 'Fixture',
    version: '1',
    origin: 'https://fixture.example.test',
    tokens: { issuer: 'https://issuer.example.test/', audience: 'https://fixture.example.test' },
    errors: defineErrors({}),
    rpc: { callers: [] },
    telemetry: { enabled: false },
  })
    .operation(
      'getContact',
      {
        ...words,
        scope: 'fixture:contacts:read',
        effect: 'read',
        input: t.Object({ contactId: UuidSchema }, { additionalProperties: false }),
        output: Contact,
        http: { method: 'GET', path: '/v1/contacts/{contactId}' },
      },
      async () => ok({} as never)
    )
    .operation(
      'listContacts',
      {
        ...words,
        scope: 'fixture:contacts:read',
        effect: 'read',
        input: inputSchema(
          t.Object(
            { ...PageQueryFields, ownerId: t.Optional(UuidSchema), email: t.Optional(EmailAddressSchema) },
            { additionalProperties: false }
          )
        ),
        output: Page(Contact, { $id: 'ContactPage' }),
        http: { method: 'GET', path: '/v1/contacts' },
      },
      async () => ok({} as never)
    )
    .operation(
      'deleteContact',
      {
        ...words,
        scope: 'fixture:contacts:write',
        effect: 'delete',
        input: t.Object({ contactId: UuidSchema }, { additionalProperties: false }),
        output: DeletedObjectSchema,
        http: { method: 'DELETE', path: '/v1/contacts/{contactId}' },
      },
      async () => ok({} as never)
    )
    .build();
}

type Json = Record<string, unknown>;
interface Document {
  paths: Record<string, Record<string, Json>>;
  components: { schemas: Record<string, Json> };
}

function operationNamed(document: Document, name: string): Json {
  const found = Object.values(document.paths)
    .flatMap((methods) => Object.values(methods))
    .find((operation) => operation.operationId === name);
  if (!found) {
    throw new Error(`No operation ${name}`);
  }
  return found;
}

const ref = (name: string, description?: string) => ({
  $ref: `#/components/schemas/${name}`,
  ...(description ? { description } : {}),
});

it('names each shared value and object once, and every use refers to it', () => {
  const document = createOpenApi(application()) as unknown as Document;
  const { schemas } = document.components;
  expect(Object.keys(schemas).toSorted()).toEqual(
    [
      'Contact',
      'ContactPage',
      'DeletedObject',
      'EmailAddress',
      'Failure',
      'FailureResponse',
      'HexColor',
      'HttpsUrl',
      'NamedReference',
      'OrganizationId',
      'PageInfo',
      'PhoneNumber',
      'PostalAddress',
      'ResponseMetadata',
      'SignedUrl',
      'Uuid',
      'ValidationIssue',
    ].toSorted()
  );
  // The scalars: their constraints in the component, their description at each use.
  expect(schemas.Uuid).toStrictEqual({ type: 'string', pattern: UuidSchema.pattern });
  expect(schemas.OrganizationId).toStrictEqual({
    type: 'string',
    pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$',
  });
  expect(schemas.EmailAddress).toStrictEqual({ type: 'string', format: 'email', maxLength: 254 });
  expect(schemas.PhoneNumber).toStrictEqual({ type: 'string', pattern: '^\\+[1-9][0-9]{1,14}$' });
  expect(schemas.HttpsUrl).toStrictEqual({
    type: 'string',
    format: 'uri',
    pattern: '^https://',
    maxLength: 2048,
  });
  expect(schemas.HexColor).toStrictEqual({ type: 'string', pattern: '^#[0-9a-fA-F]{6}$' });
  expect(schemas.Contact?.properties).toStrictEqual({
    contactId: ref('Uuid'),
    organizationId: ref('OrganizationId', 'Verified organization identifier.'),
    email: ref('EmailAddress', 'Email address.'),
    phone: { anyOf: [ref('PhoneNumber', 'Phone number in E.164 format.'), { type: 'null' }] },
    website: ref('HttpsUrl', 'An HTTPS URL.'),
    color: ref('HexColor', 'A color, as #rrggbb.'),
    address: ref('PostalAddress'),
    owner: ref('NamedReference'),
    photo: ref('SignedUrl', 'The contact photo.'),
  });
  expect(schemas.DeletedObject).toStrictEqual({
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The id of the deleted resource.' },
      deleted: { type: 'boolean', const: true },
    },
    required: ['id', 'deleted'],
    additionalProperties: false,
  });
  expect(schemas.SignedUrl).toStrictEqual({
    type: 'object',
    properties: {
      url: ref('HttpsUrl', 'The signed URL. Anyone holding it has access until it expires.'),
      expiresAt: { type: 'string', format: 'date-time', description: 'When the URL stops working.' },
    },
    required: ['url', 'expiresAt'],
    additionalProperties: false,
  });
  expect(schemas.NamedReference).toStrictEqual({
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The id of the referenced resource.' },
      name: { type: 'string', description: 'Its name.' },
    },
    required: ['id', 'name'],
    additionalProperties: false,
  });
  expect(schemas.PostalAddress).toStrictEqual({
    type: 'object',
    properties: {
      city: { type: 'string', maxLength: 120 },
      countryCode: { type: 'string', description: 'ISO 3166-1 alpha-2.', pattern: '^[A-Z]{2}$' },
      line: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 4 },
      postalCode: { type: 'string', maxLength: 20 },
      state: { type: 'string', maxLength: 120 },
      use: {
        anyOf: [
          { type: 'string', const: 'home' },
          { type: 'string', const: 'work' },
        ],
      },
    },
    additionalProperties: false,
  });
  // Path and query parameters refer to the same components.
  expect(operationNamed(document, 'getContact').parameters).toStrictEqual([
    { name: 'contactId', in: 'path', required: true, schema: ref('Uuid') },
  ]);
  expect(operationNamed(document, 'listContacts').parameters).toEqual(
    expect.arrayContaining([
      { name: 'ownerId', in: 'query', required: false, schema: ref('Uuid') },
      { name: 'email', in: 'query', required: false, schema: ref('EmailAddress', 'Email address.') },
    ])
  );
  expect(JSON.stringify(document)).not.toContain('"$id"');
  expect(Object.keys(schemas).some((name) => /_\d+$/.test(name))).toBe(false);
});

it('names the failure base every catalog narrows, and the input issue', () => {
  const app = application();
  const { schemas } = (createOpenApi(app) as unknown as Document).components;
  expect(schemas.Failure).toStrictEqual({
    type: 'object',
    properties: {
      code: { type: 'string', description: 'The failure code, stable across releases.' },
      message: {
        type: 'string',
        description: 'What went wrong, for people; it never contains input values.',
      },
      retryable: { type: 'boolean', description: 'Whether repeating the same request may succeed.' },
      data: {
        type: 'object',
        properties: {},
        description: 'Diagnostics the code declares; empty for most codes.',
      },
    },
    required: ['code', 'message', 'retryable', 'data'],
    additionalProperties: false,
  });
  const { properties } = schemas.FailureResponse as { properties: Record<string, Json> };
  const error = properties.error as {
    allOf: unknown[];
    anyOf: { properties: { code: { const: string }; data: Json } }[];
  };
  expect(error.allOf).toStrictEqual([ref('Failure')]);
  // Each code's own variant is unchanged, in catalog order.
  expect(error.anyOf.map((variant) => variant.properties.code.const)).toEqual(
    Object.values(app.errors.definitions).map(({ code }) => code)
  );
  const invalid = error.anyOf.find((variant) => variant.properties.code.const === 'INVALID_INPUT');
  expect(invalid?.properties.data).toStrictEqual({
    type: 'object',
    properties: { issues: { type: 'array', items: ref('ValidationIssue'), maxItems: 10 } },
    additionalProperties: false,
  });
  expect(schemas.ValidationIssue).toStrictEqual({
    type: 'object',
    properties: {
      path: {
        type: 'string',
        maxLength: 256,
        description: 'RFC 6901 JSON Pointer to the refused field; empty for the whole input.',
      },
      message: { type: 'string', maxLength: 256 },
    },
    required: ['path', 'message'],
    additionalProperties: false,
  });
  // Every failure the catalog creates is a Failure.
  for (const definition of Object.values(app.errors.definitions)) {
    const failure = {
      code: definition.code,
      message: definition.message,
      retryable: definition.retryable ?? false,
      data: {},
    };
    expect(parseInput(FailureSchema, failure).ok).toBe(true);
    expect(app.errors.validate(failure)).toStrictEqual(failure);
  }
});

it('validates each shared value and object as its name promises', () => {
  const cases: [TSchema, unknown[], unknown[]][] = [
    [EmailAddressSchema, ['person@example.test'], ['person', `${'a'.repeat(250)}@example.test`]],
    [PhoneNumberSchema, ['+573001234567', '+12'], ['3001234567', '+0123', '+1234567890123456', '+57 300']],
    [
      HttpsUrlSchema,
      ['https://example.test/a?b=c'],
      ['http://example.test', 'example.test', `https://${'a'.repeat(2048)}`],
    ],
    [HexColorSchema, ['#00ff7F'], ['#fff', '00ff7f', '#00ff7g']],
    [
      OrganizationIdSchema,
      // Auth0, Clerk and WorkOS organization ids, a UUID and a slug.
      [
        'org_1234567890abcdef',
        'org_2bC4dE6fG8hJ0kL2mN4pQ6rS8tU',
        'org_01HZY3K8M2N4P6Q8R0S2T4V6W8',
        '3f6c1b2e-8d4a-4c5e-9b7a-1c2d3e4f5a6b',
        'acme',
      ],
      ['', '_org', 'org/1234', 'org 1234', 'org.1234', 'org:1234', 'a'.repeat(129)],
    ],
    [
      UuidSchema,
      ['0190c6d4-8f3e-7a6b-9c1d-2e3f4a5b6c7d'],
      ['0190C6D4-8F3E-7A6B-9C1D-2E3F4A5B6C7D', 'not-a-uuid'],
    ],
    [
      DeletedObjectSchema,
      [{ id: 'rec_1', deleted: true }],
      [{ id: 'rec_1', deleted: false }, { id: 'rec_1' }, { id: 'rec_1', deleted: true, at: 1 }],
    ],
    [
      SignedUrlSchema,
      [{ url: 'https://files.example.test/a?signature=x', expiresAt: '2026-10-17T12:00:00Z' }],
      [
        { url: 'http://files.example.test/a', expiresAt: '2026-10-17T12:00:00Z' },
        { url: 'https://files.example.test/a', expiresAt: '2026-10-17' },
        { url: 'https://files.example.test/a' },
      ],
    ],
    [
      NamedReferenceSchema,
      [{ id: 'x', name: 'Main office' }],
      [{ id: 'x' }, { id: 'x', name: 'y', kind: 'z' }],
    ],
    [
      PostalAddressSchema,
      [
        {},
        {
          line: ['1 Example Street'],
          city: 'Springfield',
          countryCode: 'US',
          postalCode: '12345',
          use: 'work',
        },
      ],
      [{ countryCode: 'us' }, { line: ['a', 'b', 'c', 'd', 'e'] }, { use: 'temp' }, { country: 'US' }],
    ],
  ];
  for (const [schema, valid, invalid] of cases) {
    for (const value of valid) {
      expect(parseInput(schema, value).ok, JSON.stringify(value)).toBe(true);
    }
    for (const value of invalid) {
      expect(parseInput(schema, value).ok, JSON.stringify(value)).toBe(false);
    }
  }
});
