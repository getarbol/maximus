/**
 * Schemas in tool listings: every input and output schema self-contained, with no `$id` and local `$defs`
 * references, every input an object at the root (a union input listed as one object, its calls still checked
 * against the union), compiled by one Ajv instance as MCP clients do, and matched by what the tool returns.
 */
import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020.js';
import { expect, it, vi } from 'vite-plus/test';

import {
  EmailAddressSchema,
  Page,
  PageInfoSchema,
  PageQueryFields,
  UuidSchema,
  createHttpHandler,
  defineErrors,
  ok,
  t,
} from '../../src/index.ts';
import type { TSchema } from '../../src/index.ts';
import { defineApp, operation } from '../../src/internals.ts';
import { mcp } from '../../src/mcp/index.ts';
import { inputSchema } from '../../src/schemas.ts';

// MCP clients compile each tool's schemas with a JSON Schema validator; the MCP TypeScript SDK uses
// Ajv, which refuses a schema that declares one `$id` twice. Named schemas never reach a tool listing.

const Contact = t.Object(
  { contactId: UuidSchema, ownerId: UuidSchema, email: EmailAddressSchema },
  { $id: 'Contact', additionalProperties: false }
);
const ContactPage = Page(Contact, { $id: 'ContactPage' });
const JsonValue = t.Recursive(
  (Self) => t.Union([t.String(), t.Number(), t.Null(), t.Array(Self, { maxItems: 8 })]),
  { $id: 'JsonValue' }
);
const plain = t.Object({ query: t.String({ maxLength: 100 }) }, { additionalProperties: false });
/** One notice to a contact, by email or by text message: a union input, discriminated by its channel. */
const Notice = t.Union([
  t.Object(
    { channel: t.Literal('email'), contactId: UuidSchema, address: EmailAddressSchema },
    { additionalProperties: false }
  ),
  t.Object(
    {
      channel: t.Literal('sms'),
      contactId: UuidSchema,
      phone: t.String({ pattern: '^\\+[1-9][0-9]{7,14}$' }),
    },
    { additionalProperties: false }
  ),
]);
/** The `notify_contact` handler, which runs only for a notice the union admits. */
const notify = vi.fn(async () => ok({ query: 'sent' }));
const contact = {
  contactId: '0190c6d4-8f3e-7a6b-9c1d-2e3f4a5b6c7d',
  ownerId: '0190c6d4-8f3e-7a6b-9c1d-2e3f4a5b6c7e',
  email: 'person@example.test',
};
const pageInfo = { hasNextPage: false, hasPreviousPage: false, nextCursor: null, previousCursor: null };
const page = { object: 'list' as const, data: [contact], pageInfo };

function tool(name: string, input: TSchema, output: TSchema, value: unknown) {
  return operation({
    http: { method: 'POST', path: `/v1/contacts/${name.replaceAll('_', '-')}` },
    effect: 'read',
    scope: 'test:contacts:read',
    title: name,
    description: name,
    input,
    output,
    mcp: { name, idempotent: true },
    execute: async () => ok(value as never),
  });
}

const manifest = defineApp<Record<string, never>, null>()({
  name: 'test',
  namespace: 'test',
  title: 'Test',
  version: '1',
  origin: 'https://example.test',
  tokens: { issuer: 'https://issuer.example.test/', audience: 'https://example.test' },
  errors: defineErrors({}),
  context: async () => ok(null),
  rpc: { callers: [] },
  operations: {
    // One `Uuid` twice in the input and twice in the output.
    getContact: tool(
      'get_contact',
      t.Object({ contactId: UuidSchema, ownerId: UuidSchema }, { additionalProperties: false }),
      Contact,
      contact
    ),
    listContacts: tool(
      'list_contacts',
      inputSchema(
        t.Object({ ...PageQueryFields, ownerId: t.Optional(UuidSchema) }, { additionalProperties: false })
      ),
      ContactPage,
      page
    ),
    // Two pages in one output, and PageInfo beside them.
    compareContacts: tool(
      'compare_contacts',
      plain,
      t.Object(
        { upcoming: ContactPage, past: ContactPage, info: PageInfoSchema },
        { additionalProperties: false }
      ),
      { upcoming: page, past: page, info: pageInfo }
    ),
    // A recursive schema used twice keeps one definition.
    saveSetting: tool(
      'save_setting',
      t.Object(
        { value: JsonValue, fallback: { ...JsonValue, description: 'Used when none is set.' } },
        { additionalProperties: false }
      ),
      plain,
      { query: 'saved' }
    ),
    searchContacts: tool('search_contacts', plain, plain, { query: 'found' }),
    notifyContact: operation({
      http: { method: 'POST', path: '/v1/contacts/notify' },
      effect: 'write',
      scope: 'test:contacts:write',
      title: 'Notify a contact',
      description: 'Send one notice to a contact, by email or by text message.',
      input: Notice,
      output: plain,
      mcp: { name: 'notify_contact', idempotent: false },
      execute: notify,
    }),
  },
});
const claims = {
  sub: 'client@clients',
  client_id: 'client',
  org_id: 'org_1234567890abcdef',
  scope: 'test:contacts:read test:contacts:write test:mcp:use',
};
const handle = createHttpHandler(manifest, { transports: [mcp()], verify: async () => claims });

async function rpc(method: string, params: object = {}) {
  const response = await handle(
    new Request('https://example.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer a.b.c',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
    {}
  );
  const text = await response.text();
  return JSON.parse(/data: (\{[^\n]*)/.exec(text)?.[1] ?? text);
}

interface Tool {
  name: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

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

it('lists every tool schema self-contained, with no $id, and Ajv compiles them all on one instance', async () => {
  const { result } = await rpc('tools/list');
  const tools = result.tools as Tool[];
  expect(tools.map(({ name }) => name).toSorted()).toEqual([
    'compare_contacts',
    'get_contact',
    'list_contacts',
    'notify_contact',
    'save_setting',
    'search_contacts',
  ]);
  // As the SDK does: one validator for every tool of the listing.
  const ajv = addFormats(new Ajv2020({ strict: false }));
  for (const { name, inputSchema: input, outputSchema: output } of tools) {
    for (const schema of [input, output]) {
      expect(JSON.stringify(schema), name).not.toContain('"$id"');
      for (const reference of references(schema)) {
        expect(reference, name).toMatch(/^#\/\$defs\//);
        expect(schema.$defs, name).toHaveProperty(reference.slice('#/$defs/'.length));
      }
      expect(schema.type, name).toBe('object');
      expect(() => ajv.compile(schema), name).not.toThrow();
    }
    // Hosts refuse a combinator at the root of an input, and with it every tool of the request.
    for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
      expect(input, name).not.toHaveProperty(keyword);
    }
  }
  const byName = new Map(tools.map((entry) => [entry.name, entry]));
  // Only a definition a reference names is kept apart, once.
  expect(byName.get('save_setting')?.inputSchema).toMatchObject({
    properties: {
      value: { $ref: '#/$defs/JsonValue' },
      fallback: { $ref: '#/$defs/JsonValue', description: 'Used when none is set.' },
    },
    $defs: { JsonValue: { anyOf: expect.any(Array) } },
  });
  expect(byName.get('get_contact')?.inputSchema).not.toHaveProperty('$defs');
  // A schema without names lists exactly as before.
  expect(byName.get('search_contacts')?.inputSchema).toStrictEqual({
    ...JSON.parse(JSON.stringify(plain)),
    type: 'object',
  });
  expect(byName.get('get_contact')?.outputSchema).toStrictEqual({
    type: 'object',
    properties: {
      contactId: { type: 'string', format: 'uuid', pattern: UuidSchema.pattern },
      ownerId: { type: 'string', format: 'uuid', pattern: UuidSchema.pattern },
      email: { type: 'string', format: 'email', maxLength: 254, description: 'Email address.' },
    },
    required: ['contactId', 'ownerId', 'email'],
    additionalProperties: false,
  });

  // What a tool answers validates against what it lists.
  for (const [name, args, expected] of [
    ['list_contacts', {}, page],
    ['compare_contacts', { query: 'x' }, { upcoming: page, past: page, info: pageInfo }],
  ] as const) {
    const called = await rpc('tools/call', { name, arguments: args });
    expect(called.result.structuredContent, name).toStrictEqual(expected);
    const validate = ajv.compile(byName.get(name)?.outputSchema ?? {});
    expect(validate(called.result.structuredContent), name).toBe(true);
    expect(validate({ ...expected, extra: true }), name).toBe(false);
  }
});

it('lists a union input as one object and still checks every call against the exact union', async () => {
  const { result } = await rpc('tools/list');
  const listed = (result.tools as Tool[]).find(({ name }) => name === 'notify_contact');
  // Every member's fields; the ones both require are required; the discriminator is an enum.
  expect(listed?.inputSchema).toStrictEqual({
    type: 'object',
    properties: {
      channel: { type: 'string', enum: ['email', 'sms'] },
      contactId: { type: 'string', format: 'uuid', pattern: UuidSchema.pattern },
      address: { type: 'string', format: 'email', maxLength: 254, description: 'Email address.' },
      phone: { type: 'string', pattern: '^\\+[1-9][0-9]{7,14}$' },
    },
    required: ['channel', 'contactId'],
    additionalProperties: false,
  });
  const { contactId } = contact;
  const sent = await rpc('tools/call', {
    name: 'notify_contact',
    arguments: { channel: 'email', contactId, address: 'person@example.test' },
  });
  expect(sent.result.structuredContent).toStrictEqual({ query: 'sent' });
  notify.mockClear();
  // What the listing allows but no member admits is refused before the handler runs.
  for (const notice of [
    { channel: 'email', contactId, phone: '+15555550123' },
    { channel: 'sms', contactId, address: 'person@example.test' },
    { contactId, address: 'person@example.test' },
  ]) {
    const refused = await rpc('tools/call', { name: 'notify_contact', arguments: notice });
    expect(refused.result.isError, JSON.stringify(notice)).toBe(true);
    expect(JSON.parse(refused.result.content[0].text)).toMatchObject({ code: 'INVALID_INPUT' });
  }
  expect(notify).not.toHaveBeenCalled();
});
