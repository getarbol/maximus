/**
 * The typed client's construction and route discovery: the byte limits and base URLs it accepts, the
 * OpenAPI contracts it refuses before any operation is sent, and a failed discovery that the next call
 * repeats.
 */
import { afterEach, expect, it, vi } from 'vite-plus/test';

import { createClient } from '../../src/client/client.ts';
import { createHttpHandler, defineErrors, maximus, ok, t } from '../../src/index.ts';

const schema = t.Object({ documentNumber: t.String() }, { additionalProperties: false });
const app = maximus<Record<string, never>>({
  name: 'demo',
  namespace: 'demo',
  title: 'Demo',
  version: '2',
  origin: 'https://example.test',
  tokens: { issuer: 'https://issuer.example.test/', audience: 'demo' },
  errors: defineErrors({}),
  rpc: { callers: [] },
})
  .operation(
    'lookup',
    {
      scope: 'demo:records:read',
      title: 'Lookup',
      description: 'Read a record',
      effect: 'read',
      http: { method: 'POST', path: '/v1/records/lookup' },
      input: schema,
      output: schema,
    },
    async (_context, input) => ok(input)
  )
  // Routed and scope-checked, but absent from the published contract and from the client's type.
  .operation(
    'adjustRecord',
    {
      scope: 'demo:staff:operate',
      title: 'Adjust',
      description: 'Adjust a record',
      effect: 'write',
      http: { method: 'POST', path: '/v1/records/adjust' },
      visibility: 'internal',
      input: schema,
      output: schema,
    },
    async (_context, input) => ok(input)
  )
  .build();
const verify = async () => ({
  sub: 'client@clients',
  client_id: 'client',
  org_id: 'org_1234567890abcdef',
  scope: 'demo:records:read demo:staff:operate',
});
const REQUEST_ID = '0b5e1c9a-3f2d-4e8b-9c1a-7d6e5f4a3b2c';
const MAX_BYTES = 16 * 1024 * 1024;

/** The service as the client reaches it: the in-process handler as its fetch. */
function serve() {
  const handle = createHttpHandler(app, { verify });
  return vi.fn<typeof fetch>(async (input, init) => handle(new Request(input, init), {}));
}
/** The paths a transport was asked for, in order. */
function requestedPaths(transport: ReturnType<typeof vi.fn<typeof fetch>>): string[] {
  return transport.mock.calls.map(([input]) => new URL(String(input)).pathname);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each([0, -1, 1.5, Number.NaN, MAX_BYTES + 1])('refuses a response byte limit of %s', (limit) => {
  const transport = vi.fn<typeof fetch>();
  expect(() =>
    createClient<typeof app>(app.origin, 'a.b.c', { fetch: transport, maxResponseBytes: limit })
  ).toThrow(new RangeError('maxResponseBytes must be an integer between 1 byte and 16 MiB.'));
  expect(transport).not.toHaveBeenCalled();
});

it.each([0, -1, 1.5, Number.NaN, MAX_BYTES + 1])('refuses an attachment byte limit of %s', (limit) => {
  const transport = vi.fn<typeof fetch>();
  expect(() =>
    createClient<typeof app>(app.origin, 'a.b.c', { fetch: transport, maxAttachmentBytes: limit })
  ).toThrow(new RangeError('Invalid attachment byte limit.'));
  expect(transport).not.toHaveBeenCalled();
});

it('accepts byte limits from 1 byte up to 16 MiB inclusive', () => {
  for (const limit of [1, MAX_BYTES]) {
    expect(() =>
      createClient<typeof app>(app.origin, 'a.b.c', { maxResponseBytes: limit, maxAttachmentBytes: limit })
    ).not.toThrow();
  }
});

it.each(['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787'])(
  'allows plain HTTP on the loopback origin %s',
  async (baseUrl) => {
    const transport = serve();
    const client = createClient<typeof app>(baseUrl, 'a.b.c', { fetch: transport });
    await expect(client.lookup({ documentNumber: '123' })).resolves.toMatchObject({
      success: true,
      data: { documentNumber: '123' },
    });
    expect(transport.mock.calls.map(([input]) => new URL(String(input)).origin)).toEqual([baseUrl, baseUrl]);
  }
);

it.each(['http://example.test', 'http://127.0.0.2', 'http://localhost.example.test', 'ws://localhost'])(
  'refuses the base URL %s, which is neither HTTPS nor plain HTTP on this machine',
  (baseUrl) => {
    const transport = vi.fn<typeof fetch>();
    expect(() => createClient<typeof app>(baseUrl, 'a.b.c', { fetch: transport })).toThrow('HTTPS origin');
    expect(transport).not.toHaveBeenCalled();
  }
);

it('sends through the global fetch when no fetch is given', async () => {
  const transport = serve();
  vi.stubGlobal('fetch', transport);
  const client = createClient<typeof app>(app.origin, 'a.b.c');
  await expect(client.lookup({ documentNumber: '123' })).resolves.toMatchObject({ success: true });
  expect(requestedPaths(transport)).toEqual(['/openapi.json', '/v1/records/lookup']);
});

it('is not a thenable and has no symbol members, so awaiting it sends nothing', async () => {
  const transport = vi.fn<typeof fetch>();
  const client = createClient<typeof app>(app.origin, 'a.b.c', { fetch: transport });
  expect(Reflect.get(client, 'then')).toBeUndefined();
  expect(Reflect.get(client, Symbol.asyncIterator)).toBeUndefined();
  expect(await Promise.resolve(client)).toBe(client);
  expect(transport).not.toHaveBeenCalled();
});

it('serializes as an empty object, so logging a value that holds it sends nothing', () => {
  const transport = vi.fn<typeof fetch>();
  const client = createClient<typeof app>(app.origin, 'a.b.c', { fetch: transport });
  expect(Reflect.get(client, 'toJSON')).toBeUndefined();
  expect(JSON.stringify({ client })).toBe('{"client":{}}');
  expect(transport).not.toHaveBeenCalled();
});

it('refuses an operation that the contract does not publish', async () => {
  const transport = serve();
  const client = createClient<typeof app>(app.origin, 'a.b.c', { fetch: transport });
  // @ts-expect-error An internal operation is not a method of the client's type.
  const internal = client.adjustRecord({ documentNumber: '123' });
  await expect(internal).rejects.toThrow('Operation is not exposed over HTTP.');
  // Discovery only: the internal route is never called.
  expect(requestedPaths(transport)).toEqual(['/openapi.json']);
});

it.each([
  ['a null document', null, 'Invalid service contract.'],
  ['a document without paths', { openapi: '3.1.0' }, 'Invalid service contract.'],
  ['null paths', { paths: null }, 'Invalid service contract.'],
  ['paths that are not an object', { paths: 'everything' }, 'Invalid service contract.'],
  ['a null path item', { paths: { '/v1/records/lookup': null } }, 'Invalid service route.'],
  [
    'a path item that is not an object',
    { paths: { '/v1/records/lookup': 'post' } },
    'Invalid service route.',
  ],
  [
    'an unversioned path',
    { paths: { '/records/lookup': { post: { operationId: 'lookup' } } } },
    'Invalid service route.',
  ],
  [
    'a path that repeats a parameter',
    { paths: { '/v1/records/{id}/{id}': { get: { operationId: 'lookup' } } } },
    'Invalid service route.',
  ],
  ['a null operation', { paths: { '/v1/records/lookup': { post: null } } }, 'Invalid service operation.'],
  [
    'an operation without an id',
    { paths: { '/v1/records/lookup': { post: { summary: 'Lookup' } } } },
    'Invalid service operation.',
  ],
  [
    'an operation id that is not a string',
    { paths: { '/v1/records/lookup': { post: { operationId: 7 } } } },
    'Invalid service operation.',
  ],
  [
    'an operation id published twice',
    {
      paths: {
        '/v1/records/lookup': { post: { operationId: 'lookup' } },
        '/v1/records/search': { post: { operationId: 'lookup' } },
      },
    },
    'Invalid service operation.',
  ],
  [
    'an unknown body kind',
    { paths: { '/v1/records/lookup': { post: { operationId: 'lookup', 'x-body': 'json' } } } },
    'Invalid operation body contract.',
  ],
  [
    'an unknown response kind',
    { paths: { '/v1/records/lookup': { post: { operationId: 'lookup', 'x-response': 'inline' } } } },
    'Invalid operation body contract.',
  ],
  [
    'header fields as a list',
    { paths: { '/v1/records/lookup': { put: { operationId: 'lookup', 'x-input-headers': ['x-a'] } } } },
    'Invalid operation header contract.',
  ],
  [
    'header fields as text',
    { paths: { '/v1/records/lookup': { put: { operationId: 'lookup', 'x-input-headers': 'x-a' } } } },
    'Invalid operation header contract.',
  ],
  [
    'header fields as false',
    { paths: { '/v1/records/lookup': { put: { operationId: 'lookup', 'x-input-headers': false } } } },
    'Invalid operation header contract.',
  ],
  [
    'a header name that is not text',
    { paths: { '/v1/records/lookup': { put: { operationId: 'lookup', 'x-input-headers': { kind: 7 } } } } },
    'Invalid operation header contract.',
  ],
  [
    'a header that carries authority',
    {
      paths: {
        '/v1/records/lookup': {
          put: { operationId: 'lookup', 'x-input-headers': { token: 'authorization' } },
        },
      },
    },
    'Invalid operation header contract.',
  ],
  [
    'a header name with a space',
    {
      paths: {
        '/v1/records/lookup': { put: { operationId: 'lookup', 'x-input-headers': { kind: 'x kind' } } },
      },
    },
    'Invalid operation header contract.',
  ],
  [
    'a header for an unnamed field',
    {
      paths: {
        '/v1/records/lookup': { put: { operationId: 'lookup', 'x-input-headers': { '': 'x-kind' } } },
      },
    },
    'Invalid operation header contract.',
  ],
])('refuses a contract with %s before sending any operation', async (_name, document, message) => {
  const transport = vi.fn<typeof fetch>(async () => Response.json(document));
  const client = createClient<typeof app>(app.origin, 'a.b.c', { fetch: transport });
  await expect(client.lookup({ documentNumber: '123' })).rejects.toThrow(message);
  expect(transport).toHaveBeenCalledOnce();
});

it.each([
  ['a failure status', () => Response.json({ paths: {} }, { status: 503 })],
  [
    'a body that is not JSON',
    () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
  ],
  [
    'a document above 4 MiB',
    () => Response.json({ paths: {}, padding: 'x'.repeat(4 * 1024 * 1024) }, { status: 200 }),
  ],
])('refuses a discovery answer with %s', async (_name, answer) => {
  const transport = vi.fn<typeof fetch>(async () => answer());
  const client = createClient<typeof app>(app.origin, 'a.b.c', { fetch: transport });
  await expect(client.lookup({ documentNumber: '123' })).rejects.toThrow('Invalid service contract.');
  expect(transport).toHaveBeenCalledOnce();
});

it('ignores path item fields that are not HTTP methods', async () => {
  const transport = vi.fn<typeof fetch>(async (input) =>
    new URL(String(input)).pathname === '/openapi.json'
      ? Response.json({
          paths: {
            '/v1/records/lookup': {
              summary: 'Records',
              parameters: [],
              // Read as an operation, this would publish the same id twice.
              head: { operationId: 'lookup' },
              post: { operationId: 'lookup' },
            },
          },
        })
      : Response.json({
          success: true,
          data: { documentNumber: '123' },
          error: null,
          metadata: { requestId: REQUEST_ID },
        })
  );
  const client = createClient<typeof app>(app.origin, 'a.b.c', { fetch: transport });
  await expect(client.lookup({ documentNumber: '123' })).resolves.toStrictEqual({
    success: true,
    data: { documentNumber: '123' },
    error: null,
    metadata: { requestId: REQUEST_ID },
  });
  expect(transport.mock.calls[1]?.[1]?.method).toBe('POST');
});

it('repeats a failed discovery on the next call, then keeps the routes it read', async () => {
  const handle = createHttpHandler(app, { verify });
  let outage = true;
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    if (outage && new URL(String(input)).pathname === '/openapi.json') {
      outage = false;
      return new Response('Service unavailable', { status: 503 });
    }
    return handle(new Request(input, init), {});
  });
  const client = createClient<typeof app>(app.origin, 'a.b.c', { fetch: transport });
  await expect(client.lookup({ documentNumber: '1' })).rejects.toThrow('Invalid service contract.');
  await expect(client.lookup({ documentNumber: '2' })).resolves.toMatchObject({ success: true });
  await expect(client.lookup({ documentNumber: '3' })).resolves.toMatchObject({ success: true });
  expect(requestedPaths(transport)).toEqual([
    '/openapi.json',
    '/openapi.json',
    '/v1/records/lookup',
    '/v1/records/lookup',
  ]);
});
