/**
 * How an operation's input is assembled from a request: a GET query read field by field as its kind, a
 * JSON body, an empty DELETE, a byte upload's query and header metadata, and path parameters that only the
 * path may carry; and the attachment an operation answers with.
 */
import { expect, it, vi } from 'vite-plus/test';

import { AttachmentOutputSchema, createHttpHandler, defineErrors, maximus, ok, t } from '../../src/index.ts';
import { queryInput, queryKinds } from '../../src/internal/http-query.ts';

const ISSUER = 'https://issuer.example.test/';
const ORIGIN = 'https://records.example.test';
/** A machine client of the organization that may read and write records. */
const claims = {
  sub: 'client@clients',
  client_id: 'client',
  org_id: 'org_1234567890abcdef',
  scope: 'records:records:read records:records:write',
};
const strict = { additionalProperties: false } as const;
const recordId = t.String({ minLength: 1 });
const empty = t.Object({}, strict);
const reading = {
  scope: 'records:records:read',
  title: 'Read records',
  description: 'Read the organization records.',
  effect: 'read' as const,
};
const writing = {
  scope: 'records:records:write',
  title: 'Change records',
  description: 'Change the organization records.',
  effect: 'write' as const,
};

/**
 * A search read from the query string: a number, a list or nothing, a list or text, a list or an integer,
 * text or an integer, and a pair.
 */
const search = t.Object(
  {
    ratio: t.Optional(t.Number()),
    labels: t.Optional(t.Union([t.Array(t.String()), t.Null()])),
    tags: t.Optional(t.Union([t.Array(t.String()), t.String()])),
    codes: t.Optional(t.Union([t.Array(t.String()), t.Integer()])),
    depth: t.Optional(t.Union([t.Integer(), t.Literal('all')])),
    window: t.Optional(t.Tuple([t.String(), t.String()])),
  },
  strict
);
const target = t.Object({ recordId }, strict);
const lookup = t.Object({ recordId, fields: t.Optional(t.Array(t.String())) }, strict);
const note = t.Object({ recordId, text: t.String() }, strict);
const rename = t.Object({ recordId, kind: t.Literal('rename'), name: t.String() }, strict);
const change = t.Union([rename, t.Object({ recordId, kind: t.Literal('archive') }, strict)]);
const upload = t.Object(
  { recordId, contentType: t.String(), fileName: t.Optional(t.String()), note: t.Optional(t.String()) },
  strict
);
const uploaded = t.Object({ ...upload.properties, bytes: t.Integer() }, strict);

const base = maximus<Record<string, never>>({
  name: 'records',
  namespace: 'records',
  title: 'Records',
  version: '1',
  origin: ORIGIN,
  tokens: { issuer: ISSUER, audience: ORIGIN },
  errors: defineErrors({}),
  rpc: { callers: [] },
  telemetry: { enabled: false },
});
/** A CSV file as an attachment output. */
function csv(filename: string) {
  const body = new TextEncoder().encode('id,name\nr1,Q3\n');
  return { body, contentType: 'text/csv', filename, byteLength: body.byteLength };
}
const app = base
  .operation(
    'findRecords',
    { ...reading, input: search, output: search, http: { method: 'GET', path: '/v1/records' } },
    async (_context, input) => ok(input)
  )
  .operation(
    'readRecord',
    { ...reading, input: lookup, output: lookup, http: { method: 'GET', path: '/v1/records/{recordId}' } },
    async (_context, input) => ok(input)
  )
  .operation(
    'annotateRecord',
    { ...writing, input: note, output: note, http: { method: 'POST', path: '/v1/records/{recordId}/notes' } },
    async (_context, input) => ok(input)
  )
  .operation(
    'changeRecord',
    { ...writing, input: change, output: change, http: { method: 'PATCH', path: '/v1/records/{recordId}' } },
    async (_context, input) => ok(input)
  )
  .operation(
    'removeRecord',
    {
      ...writing,
      effect: 'delete',
      input: target,
      output: target,
      http: { method: 'DELETE', path: '/v1/records/{recordId}' },
    },
    async (_context, input) => ok(input)
  )
  .operation(
    'uploadAttachment',
    {
      ...writing,
      input: upload,
      output: uploaded,
      http: {
        method: 'PUT',
        path: '/v1/records/{recordId}/attachment',
        body: 'bytes',
        headers: { contentType: 'content-type', fileName: 'x-file-name' },
      },
    },
    async ({ body }, input) => {
      const bytes = await body.read();
      return bytes.ok ? ok({ ...input, bytes: bytes.value.byteLength }) : bytes;
    }
  )
  .operation(
    'exportRecord',
    {
      ...reading,
      input: target,
      output: AttachmentOutputSchema,
      http: { method: 'GET', path: '/v1/records/{recordId}/export', response: 'attachment' },
    },
    async (_context, input) => ok(csv(`record ${input.recordId}.csv`))
  )
  .operation(
    'renderReport',
    {
      ...writing,
      input: empty,
      output: AttachmentOutputSchema,
      http: { method: 'POST', path: '/v1/reports', response: 'attachment', successStatus: 201 },
    },
    async () => ok(csv('report.csv'))
  )
  .build();
const handle = createHttpHandler(app, { verify: async () => claims });
const authorization = { authorization: 'Bearer a.b.c' };

/** A call with a token, and the body and headers given. */
function call(
  method: string,
  path: string,
  init: { body?: BodyInit; headers?: Record<string, string> } = {}
) {
  return handle(
    new Request(`${ORIGIN}${path}`, {
      method,
      body: init.body,
      headers: { ...authorization, ...init.headers },
    }),
    {}
  );
}
/** A JSON body. */
function json(value: unknown) {
  return { body: JSON.stringify(value), headers: { 'content-type': 'application/json' } };
}
/** The data of a successful envelope. */
async function data(response: Response) {
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: unknown }).data;
}
/** Whether the response refuses the input. */
async function refused(response: Response) {
  return response.status === 400 && ((await response.json()) as { error: { code: string } }).error.code;
}

it('reads each GET query field as its kind, and never coerces text it cannot read as one', async () => {
  expect(
    await data(await call('GET', '/v1/records?ratio=0.25&labels=urgent,billing&tags=q3&depth=all'))
  ).toStrictEqual({
    ratio: 0.25,
    labels: ['urgent', 'billing'],
    // A list or text is always read as a list.
    tags: ['q3'],
    depth: 'all',
  });
  expect(await data(await call('GET', '/v1/records?ratio=-1.5e3'))).toStrictEqual({ ratio: -1500 });
  // Not finite, not a decimal, repeated; a list or an integer, text or an integer, and a pair have no
  // query kind, so they stay text that the schema refuses.
  for (const query of [
    '?ratio=1e999',
    '?ratio=.5',
    '?ratio=0x10',
    '?ratio=1&ratio=2',
    '?codes=7',
    '?depth=3',
    '?window=2026-01-01,2026-02-01',
  ]) {
    expect(await refused(await call('GET', `/v1/records${query}`)), query).toBe('INVALID_INPUT');
  }
});

it('reads oneOf alternatives and bare string enumerations from other schema generators as text', () => {
  const input = t.Object(
    {
      state: t.Unsafe<string>({ enum: ['open', 'closed'] }),
      code: t.Unsafe<string>({
        oneOf: [
          { type: 'string', format: 'uuid' },
          { type: 'string', pattern: '^R[0-9]+$' },
        ],
      }),
      weight: t.Unsafe<number>({ enum: [1, 2] }),
      pair: t.Unsafe<string[]>({ type: 'array', items: [{ type: 'string' }] }),
      nothing: t.Unsafe<string>({ oneOf: [] }),
    },
    strict
  );
  const searched = base
    .operation(
      'searchRecords',
      { ...reading, input, output: empty, http: { method: 'GET', path: '/v1/search' } },
      async () => ok({})
    )
    .build();
  const kinds = queryKinds(searched.operations.searchRecords);
  expect(kinds).toStrictEqual(
    new Map([
      ['state', 'string'],
      ['code', 'string'],
    ])
  );
  // A field without a kind reaches the schema as the text it was sent.
  expect(queryInput(kinds, new URLSearchParams('state=open&code=R12&weight=2'))).toStrictEqual({
    state: 'open',
    code: 'R12',
    weight: '2',
  });
});

it('merges path parameters into the input, refusing one that the query or the body repeats', async () => {
  expect(await data(await call('GET', '/v1/records/r%201?fields=name,owner'))).toStrictEqual({
    recordId: 'r 1',
    fields: ['name', 'owner'],
  });
  expect(await data(await call('POST', '/v1/records/r1/notes', json({ text: 'Call back' })))).toStrictEqual({
    recordId: 'r1',
    text: 'Call back',
  });
  const repeated: [string, string, ReturnType<typeof json> | undefined][] = [
    ['GET', '/v1/records/r1?recordId=r2', undefined],
    ['GET', '/v1/records/r1?recordId=r1', undefined],
    ['POST', '/v1/records/r1/notes?recordId=r1', json({ text: 'Call back' })],
    ['POST', '/v1/records/r1/notes', json({ recordId: 'r1', text: 'Call back' })],
    // A body that is not an object has nowhere to receive the path parameter.
    ['POST', '/v1/records/r1/notes', json(['Call back'])],
    ['POST', '/v1/records/r1/notes', json(null)],
    ['POST', '/v1/records/r1/notes', json('Call back')],
  ];
  for (const [method, path, init] of repeated) {
    expect(await refused(await call(method, path, init)), `${method} ${path} ${init?.body}`).toBe(
      'INVALID_INPUT'
    );
  }
});

it('decodes a path parameter once and refuses, before the token, one that could change URL ownership', async () => {
  const verify = vi.fn(async () => claims);
  const guarded = createHttpHandler(app, { verify });
  const get = (path: string) => guarded(new Request(`${ORIGIN}${path}`, { headers: authorization }), {});
  expect(await data(await get('/v1/records/%252F'))).toStrictEqual({ recordId: '%2F' });
  verify.mockClear();
  for (const segment of ['%2F', 'a%2Fb', '%5C', '%00', '%7F', '%E0%A4%A']) {
    const response = await get(`/v1/records/${segment}`);
    expect(response.status, segment).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  }
  expect(verify).not.toHaveBeenCalled();
});

it('reads an empty DELETE as the empty input, and a DELETE that sends a body as JSON', async () => {
  expect(await data(await call('DELETE', '/v1/records/r1'))).toStrictEqual({ recordId: 'r1' });
  expect(await data(await call('DELETE', '/v1/records/r1', json({})))).toStrictEqual({ recordId: 'r1' });
  const text = await call('DELETE', '/v1/records/r1', {
    body: 'r1',
    headers: { 'content-type': 'text/plain' },
  });
  expect(text.status).toBe(415);
  expect(await text.json()).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } });
});

it('merges a path parameter into whichever member of a union input the body chooses', async () => {
  expect(
    await data(await call('PATCH', '/v1/records/r1', json({ kind: 'rename', name: 'Q3' })))
  ).toStrictEqual({ recordId: 'r1', kind: 'rename', name: 'Q3' });
  expect(await data(await call('PATCH', '/v1/records/r1', json({ kind: 'archive' })))).toStrictEqual({
    recordId: 'r1',
    kind: 'archive',
  });
  expect(
    await refused(await call('PATCH', '/v1/records/r1', json({ kind: 'archive', recordId: 'r2' })))
  ).toBe('INVALID_INPUT');
  // Every member must declare the path parameter as a required string field.
  for (const member of [
    t.Object({ kind: t.Literal('archive') }, strict),
    t.Object({ recordId: t.Optional(t.String()), kind: t.Literal('archive') }, strict),
    t.Object({ recordId: t.Integer(), kind: t.Literal('archive') }, strict),
  ]) {
    const declared = base.operation(
      'changeRecord',
      {
        ...writing,
        input: t.Union([rename, member]),
        output: empty,
        http: { method: 'PATCH', path: '/v1/records/{recordId}' },
      },
      async () => ok({})
    );
    expect(() => declared.build()).toThrow(
      'Path parameter "recordId" must be a required string input field.'
    );
  }
});

it("reads a byte upload's metadata from its query and mapped headers, never from both", async () => {
  const put = (query: string, headers: Record<string, string> = {}) =>
    call('PUT', `/v1/records/r1/attachment${query}`, {
      body: 'id,name\nr1,Q3\n',
      headers: { 'content-type': 'text/csv', ...headers },
    });
  expect(await data(await put('?note=signed', { 'x-file-name': 'q3.csv' }))).toStrictEqual({
    recordId: 'r1',
    note: 'signed',
    contentType: 'text/csv',
    fileName: 'q3.csv',
    bytes: 14,
  });
  expect(await data(await put(''))).toStrictEqual({ recordId: 'r1', contentType: 'text/csv', bytes: 14 });
  for (const query of ['?note=a&note=b', '?contentType=text/plain', '?recordId=r2']) {
    expect(await refused(await put(query)), query).toBe('INVALID_INPUT');
  }
  // A header that carries authority or framing, or is not a plain header name, is never input metadata.
  for (const header of ['Authorization', 'cookie', 'Content-Length', 'x_file_name']) {
    const declared = base.operation(
      'uploadAttachment',
      {
        ...writing,
        input: upload,
        output: empty,
        http: {
          method: 'PUT',
          path: '/v1/records/{recordId}/attachment',
          body: 'bytes',
          headers: { fileName: header },
        },
      },
      async () => ok({})
    );
    expect(() => declared.build(), header).toThrow(
      'Byte operation headers must name unique, non-authority metadata fields.'
    );
  }
});

it('answers an attachment with its validated headers and the declared success status', async () => {
  const exported = await call('GET', '/v1/records/r1/export');
  expect(exported.status).toBe(200);
  expect(Object.fromEntries(exported.headers)).toMatchObject({
    'content-type': 'text/csv',
    'content-length': '14',
    'content-disposition': `attachment; filename="record r1.csv"; filename*=UTF-8''record%20r1.csv`,
    'content-security-policy': "default-src 'none'; sandbox",
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  });
  expect(await exported.text()).toBe('id,name\nr1,Q3\n');
  const rendered = await call('POST', '/v1/reports', json({}));
  expect(rendered.status).toBe(201);
  expect(rendered.headers.get('content-disposition')).toContain('filename="report.csv"');
  expect(await rendered.text()).toBe('id,name\nr1,Q3\n');
});
