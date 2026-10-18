/**
 * The typed HTTP client: route discovery from the live OpenAPI document, fresh tokens, typed envelopes,
 * and refusals of contracts or redirects that could send authority elsewhere.
 */
import { it, expect, vi } from 'vitest';

import { createClient } from '../../src/client/client.ts';
import { maximus, defineErrors, t, ok, createHttpHandler } from '../../src/index.ts';

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
  .build();
it('discovers native routes once, uses fresh tokens and returns the typed envelope', async () => {
  const handle = createHttpHandler(app, {
    verify: async () => ({
      sub: 'client@clients',
      client_id: 'client',
      org_id: 'org_1234567890abcdef',
      scope: 'demo:records:read',
    }),
  });
  const transport = vi.fn<typeof fetch>(async (url, options) => handle(new Request(url, options), {}));
  const token = vi.fn(async () => 'a.b.c');
  const client = createClient<typeof app>(app.origin, token, { fetch: transport });
  const [one, two] = await Promise.all([
    client.lookup({ documentNumber: '123' }),
    client.lookup({ documentNumber: '456' }),
  ]);
  expect(one).toMatchObject({ success: true, data: { documentNumber: '123' } });
  expect(two).toMatchObject({ success: true, data: { documentNumber: '456' } });
  expect(transport).toHaveBeenCalledTimes(3);
  expect(token).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls.every(([, options]) => options?.redirect === 'manual')).toBe(true);
});
it('rejects contract paths that could forward authority elsewhere', async () => {
  const transport = vi.fn<typeof fetch>(async () =>
    Response.json({ paths: { '//attacker.test/steal': { post: { operationId: 'lookup' } } } })
  );
  const client = createClient<typeof app>(app.origin, 'secret', { fetch: transport });
  await expect(client.lookup({ documentNumber: '123' })).rejects.toThrow('Invalid service route');
  expect(transport).toHaveBeenCalledOnce();
  expect(transport.mock.calls[0]?.[1]?.headers).toBeUndefined();
});

it('does not follow discovery redirects', async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.redirect('https://other.test', 307));
  const client = createClient<typeof app>(app.origin, 'secret', { fetch: transport });
  await expect(client.lookup({ documentNumber: '123' })).rejects.toThrow('Invalid service contract');
  expect(transport).toHaveBeenCalledOnce();
  expect(transport.mock.calls[0]?.[1]?.redirect).toBe('manual');
});

it.each(['https://example.test/api', 'https://example.test/api/'])(
  'keeps discovery and authorized calls under %s',
  async (baseUrl) => {
    const handle = createHttpHandler(app, {
      verify: async () => ({
        sub: 'client@clients',
        client_id: 'client',
        org_id: 'org_1234567890abcdef',
        scope: 'demo:records:read',
      }),
    });
    const transport = vi.fn<typeof fetch>(async (input, options) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://example.test');
      expect(url.pathname.startsWith('/api/')).toBe(true);
      url.pathname = url.pathname.slice('/api'.length);
      return handle(new Request(url, options), {});
    });
    const client = createClient<typeof app>(baseUrl, 'a.b.c', { fetch: transport });
    await expect(client.lookup({ documentNumber: '123' })).resolves.toMatchObject({ success: true });
    expect(transport.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/openapi.json',
      '/api/v1/records/lookup',
    ]);
    expect(transport.mock.calls[0]?.[1]?.headers).toBeUndefined();
    expect(transport.mock.calls[1]?.[1]?.headers).toMatchObject({ authorization: 'Bearer a.b.c' });
  }
);

it.each([
  'https://example.test/api?redirect=elsewhere',
  'https://example.test/api#fragment',
  'https://example.test/api//other',
  'https://example.test/api/%2fother',
  'https://user:secret@example.test/api',
])('rejects an ambiguous service base URL %s before discovery', (baseUrl) => {
  const transport = vi.fn<typeof fetch>();
  expect(() => createClient<typeof app>(baseUrl, 'secret', { fetch: transport })).toThrow('HTTPS origin');
  expect(transport).not.toHaveBeenCalled();
});

it('writes a GET input the way the service reads its query back', async () => {
  const query = t.Object(
    {
      limit: t.Integer({ minimum: 1, maximum: 50 }),
      ratio: t.Optional(t.Number()),
      active: t.Boolean(),
      tags: t.Array(t.String({ minLength: 1 })),
      name: t.Optional(t.String()),
    },
    { additionalProperties: false }
  );
  const listing = maximus<Record<string, never>>({
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
      'listRecords',
      {
        scope: 'demo:records:read',
        title: 'List records',
        description: 'List the records that match a query',
        effect: 'read',
        http: { method: 'GET', path: '/v1/records' },
        input: query,
        output: query,
      },
      async (_context, input) => ok(input)
    )
    .build();
  const handle = createHttpHandler(listing, {
    verify: async () => ({
      sub: 'client@clients',
      client_id: 'client',
      org_id: 'org_1234567890abcdef',
      scope: 'demo:records:read',
    }),
  });
  const transport = vi.fn<typeof fetch>(async (url, options) => handle(new Request(url, options), {}));
  const client = createClient<typeof listing>(listing.origin, 'a.b.c', {
    fetch: transport,
    response: 'data',
  });
  const input = { limit: 10, ratio: 0.5, active: false, tags: ['urgent', 'open'], name: 'x' };
  // Numbers, booleans and lists travel as the text the query codec reads back into the same values.
  expect(await client.listRecords(input)).toStrictEqual(input);
  expect(new URL(String(transport.mock.calls.at(-1)?.[0])).search).toBe(
    '?limit=10&ratio=0.5&active=false&tags=urgent%2Copen&name=x'
  );
  // What no query string can carry is refused before anything is sent.
  const sent = transport.mock.calls.length;
  for (const refused of [
    { ...input, tags: ['a,b'] },
    { ...input, tags: [] },
    { ...input, limit: Number.NaN },
  ]) {
    await expect(client.listRecords(refused)).rejects.toThrow('Query values must be');
  }
  expect(transport).toHaveBeenCalledTimes(sent);
});
