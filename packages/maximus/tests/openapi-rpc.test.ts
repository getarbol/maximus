/**
 * The RPC document: every operation an application serves over native RPC, internal ones and tools included,
 * as `POST /rpc/<name>` with its whole input as the body, named as the HTTP document names its answers and
 * failures, without the HTTP document's security, servers or body failures.
 */
import { expect, it } from 'vite-plus/test';

import { createOpenApi, createRpcOpenApi, defineErrors, maximus, ok, t } from '../src/index.ts';

const errors = defineErrors({
  unknownSku: {
    code: 'UNKNOWN_SKU',
    status: 422,
    message: 'An item is not in the catalog.',
    dataSchema: t.Object({ index: t.Integer({ minimum: 0 }) }, { additionalProperties: false }),
  },
});
const quote = t.Object({ totalCents: t.Integer() }, { $id: 'Quote', additionalProperties: false });
const items = t.Object(
  { items: t.Array(t.Object({ sku: t.String() }, { additionalProperties: false })) },
  { additionalProperties: false }
);

/** Pricing: an internal route served over RPC, a tool served over RPC to one caller, and a public route. */
function pricing() {
  return maximus<Record<string, never>>({
    name: 'pricing',
    namespace: 'pricing',
    title: 'Pricing',
    version: '1',
    origin: 'https://pricing.example.test',
    tokens: { issuer: 'https://issuer.example.test/', audience: 'https://pricing.example.test' },
    errors,
    rpc: { callers: ['orders', 'billing'] },
    telemetry: { enabled: false },
  })
    .operation(
      'quoteItems',
      {
        title: 'Quote items',
        description: 'Price the items.',
        effect: 'read',
        scope: 'pricing:quotes:read',
        input: items,
        output: quote,
        failures: ['UNKNOWN_SKU'],
        http: { method: 'POST', path: '/v1/quotes' },
        visibility: 'internal',
        rpc: true,
        actorKinds: ['user', 'service'],
      },
      async () => ok({ totalCents: 0 })
    )
    .operation(
      'summarizeQuotes',
      {
        title: 'Summarize quotes',
        description: 'Summarize the quotes of a day.',
        group: 'Reports',
        effect: 'read',
        scope: 'pricing:reports:read',
        input: t.Object({ day: t.String() }, { additionalProperties: false }),
        output: t.Object({ count: t.Integer() }, { additionalProperties: false }),
        failures: [],
        mcp: { name: 'summarize_quotes', idempotent: true },
        rpc: { callers: ['billing'] },
        actorKinds: ['user', 'service'],
      },
      async () => ok({ count: 0 })
    )
    .operation(
      'listPrices',
      {
        title: 'List prices',
        description: 'The catalog prices.',
        effect: 'read',
        scope: 'pricing:prices:read',
        input: t.Object({}, { additionalProperties: false }),
        output: t.Object({ count: t.Integer() }, { additionalProperties: false }),
        http: { method: 'GET', path: '/v1/prices' },
        actorKinds: ['user', 'service'],
      },
      async () => ok({ count: 0 })
    )
    .build();
}

type Json = Record<string, unknown>;

it('lists each operation served over RPC, internal or a tool, under its method, with its whole input as the body', () => {
  const document = createRpcOpenApi(pricing()) as Json & { paths: Record<string, { post: Json }> };
  expect(Object.keys(document.paths)).toEqual(['/rpc/quoteItems', '/rpc/summarizeQuotes']);
  expect(document).not.toHaveProperty('servers');
  expect(document.info).toMatchObject({
    title: 'Pricing',
    description: expect.stringContaining('No HTTP route answers these paths'),
  });
  expect(document.tags).toStrictEqual([{ name: 'Quotes' }, { name: 'Reports' }]);
  const quoteItems = document.paths['/rpc/quoteItems']?.post ?? {};
  expect(quoteItems).toMatchObject({
    operationId: 'quoteItems',
    tags: ['Quotes'],
    'x-native-rpc': true,
    'x-rpc-callers': ['orders', 'billing'],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/QuoteItemsInput' } } },
    },
  });
  // A Service Binding names its caller: no token, so no security requirement.
  expect(quoteItems).not.toHaveProperty('security');
  expect(document.paths['/rpc/summarizeQuotes']?.post).toMatchObject({ 'x-rpc-callers': ['billing'] });
  // The answers and failures the HTTP document names, without a body's own failures.
  const responses = quoteItems.responses as Json;
  expect(Object.keys(responses)).toEqual([
    '200',
    '400',
    '401',
    '403',
    '422',
    '429',
    '500',
    '502',
    '503',
    '504',
  ]);
  expect(responses['422']).toMatchObject({
    'x-failure-codes': ['UNKNOWN_SKU'],
    content: { 'application/json': { schema: { $ref: '#/components/schemas/UnknownSkuError' } } },
  });
  const components = (document.components as { schemas: Json; securitySchemes?: unknown }).schemas;
  expect(components.QuoteResponse).toMatchObject({
    properties: { data: { $ref: '#/components/schemas/Quote' } },
  });
  expect(document.components).not.toHaveProperty('securitySchemes');
});

it('leaves an application without RPC methods an RPC document of no paths, and its HTTP document as it was', () => {
  const app = pricing();
  expect(createRpcOpenApi({ ...app, operations: { listPrices: app.operations.listPrices } })).toMatchObject({
    paths: {},
  });
  // The HTTP document still leaves the internal route out.
  expect(Object.keys((createOpenApi(app) as { paths: Json }).paths)).toEqual(['/v1/prices']);
});

it('describes a group only RPC serves, and writes no shared component into a document of no operations', () => {
  const app = pricing();
  const described = { ...app, groups: { Quotes: 'Quotes of catalog items, in US cents.' } };
  expect((createRpcOpenApi(described) as Json).tags).toStrictEqual([
    { name: 'Quotes', description: 'Quotes of catalog items, in US cents.' },
    { name: 'Reports' },
  ]);
  // The HTTP document, which leaves the internal route out, takes the same description.
  expect(Object.keys((createOpenApi(described) as { paths: Json }).paths)).toEqual(['/v1/prices']);
  // A Worker whose routes are all internal publishes an HTTP document without operations, or what they share.
  const internal = createOpenApi({ ...app, operations: { quoteItems: app.operations.quoteItems } });
  expect(internal).toMatchObject({ paths: {}, tags: [] });
  expect((internal as { components: Json }).components).toStrictEqual({ schemas: {} });
});
