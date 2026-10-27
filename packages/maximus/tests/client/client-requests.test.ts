/**
 * How the typed client writes each call: path fields in their own segments, the query of a GET or an
 * upload, header-mapped fields, byte and JSON bodies, the request hooks and Fetch modes, upload progress,
 * and cancellation by the caller, the client's lifecycle or its deadline.
 */
import { expect, it, vi } from 'vite-plus/test';

import { createClient } from '../../src/client/client.ts';
import type { ClientOptions } from '../../src/client/client.ts';
import { createHttpHandler, defineErrors, err, maximus, ok, t } from '../../src/index.ts';

const errors = defineErrors({
  checksumMismatch: {
    code: 'CHECKSUM_MISMATCH',
    status: 422,
    message: 'The checksum does not match the bytes.',
  },
});
const record = t.Object(
  { recordId: t.String(), view: t.Optional(t.String()) },
  { additionalProperties: false }
);
const rename = t.Object({ recordId: t.String(), name: t.String() }, { additionalProperties: false });
const upload = t.Object(
  {
    fileId: t.String(),
    contentType: t.Optional(t.String()),
    checksum: t.Optional(t.String()),
    label: t.Optional(t.String()),
  },
  { additionalProperties: false }
);
const stored = t.Object(
  {
    fileId: t.String(),
    bytes: t.Integer(),
    contentType: t.Optional(t.String()),
    checksum: t.Optional(t.String()),
    label: t.Optional(t.String()),
  },
  { additionalProperties: false }
);
const app = maximus<Record<string, never>>({
  name: 'files',
  namespace: 'files',
  title: 'Files',
  version: '1',
  origin: 'https://files.example.test',
  tokens: { issuer: 'https://issuer.example.test/', audience: 'files' },
  errors,
  rpc: { callers: [] },
})
  .operation(
    'getRecord',
    {
      scope: 'files:records:read',
      title: 'Get a record',
      description: 'Read one record.',
      effect: 'read',
      http: { method: 'GET', path: '/v1/records/{recordId}' },
      input: record,
      output: record,
    },
    async (_context, input) => ok(input)
  )
  .operation(
    'renameRecord',
    {
      scope: 'files:records:write',
      title: 'Rename a record',
      description: 'Rename one record.',
      effect: 'write',
      http: { method: 'PATCH', path: '/v1/records/{recordId}' },
      input: rename,
      output: rename,
    },
    async (_context, input) => ok(input)
  )
  .operation(
    'uploadFile',
    {
      scope: 'files:files:write',
      title: 'Upload a file',
      description: 'Store the request body as a file.',
      effect: 'write',
      http: {
        method: 'PUT',
        path: '/v1/files/{fileId}',
        body: 'bytes',
        headers: { contentType: 'content-type', checksum: 'x-checksum' },
      },
      input: upload,
      output: stored,
    },
    async ({ body }, input) => {
      if (input.checksum === 'mismatch') {
        return err(errors.checksumMismatch.create());
      }
      const bytes = await body.read();
      return bytes.ok ? ok({ ...input, bytes: bytes.value.byteLength }) : bytes;
    }
  )
  .build();
const verify = async () => ({
  sub: 'client@clients',
  client_id: 'client',
  org_id: 'org_1234567890abcdef',
  scope: 'files:records:read files:records:write files:files:write',
});
const PATH_REFUSAL = 'Path values must be nonempty strings without slashes, dot segments or controls.';

/** An envelope-mode client of the in-process service, and the transport every request goes through. */
function connect(options: Omit<ClientOptions, 'fetch' | 'response'> = {}) {
  const handle = createHttpHandler(app, { verify });
  const transport = vi.fn<typeof fetch>(async (input, init) => handle(new Request(input, init), {}));
  const client = createClient<typeof app>(app.origin, 'a.b.c', { ...options, fetch: transport });
  return { client, transport };
}
/** The paths a transport was asked for, in order. */
function requestedPaths(transport: ReturnType<typeof vi.fn<typeof fetch>>): string[] {
  return transport.mock.calls.map(([input]) => new URL(String(input)).pathname);
}
/** A promise that settles when a test opens it: holds a transport's answer at a known point. */
function gate() {
  let open = () => {};
  // oxlint-disable-next-line promise/avoid-new -- The test opens it at a point of its choosing; no library promise does.
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

it('puts each path field in its own encoded segment and the rest of a GET in its query', async () => {
  const { client, transport } = connect();
  await expect(client.getRecord({ recordId: 'a b?c#d', view: 'full' })).resolves.toMatchObject({
    success: true,
    data: { recordId: 'a b?c#d', view: 'full' },
  });
  const sent = new URL(String(transport.mock.calls[1]?.[0]));
  expect(sent.pathname).toBe('/v1/records/a%20b%3Fc%23d');
  expect(sent.search).toBe('?view=full');
  expect(transport.mock.calls[1]?.[1]?.body).toBeUndefined();
});

it.each(['', '.', '..', 'a/b', String.raw`a\b`, 'line\nbreak', 'nul\u0000', 'delete\u007F'])(
  'refuses the path value %j before sending it',
  async (recordId) => {
    const { client, transport } = connect();
    await expect(client.getRecord({ recordId })).rejects.toThrow(new TypeError(PATH_REFUSAL));
    expect(requestedPaths(transport)).toEqual(['/openapi.json']);
  }
);

it('refuses a path field that is not a string', async () => {
  const { client, transport } = connect();
  // @ts-expect-error A path field is a string.
  const numbered = client.getRecord({ recordId: 42 });
  await expect(numbered).rejects.toThrow(new TypeError(PATH_REFUSAL));
  expect(requestedPaths(transport)).toEqual(['/openapi.json']);
});

it('leaves undefined fields out of a GET query', async () => {
  const { client, transport } = connect();
  await expect(client.getRecord({ recordId: 'r1', view: undefined })).resolves.toStrictEqual({
    success: true,
    data: { recordId: 'r1' },
    error: null,
    metadata: { requestId: expect.any(String) },
  });
  expect(new URL(String(transport.mock.calls[1]?.[0])).search).toBe('');
});

it('sends a JSON write as a JSON body without its path fields', async () => {
  const { client, transport } = connect();
  await expect(client.renameRecord({ recordId: 'r1', name: 'Renamed' })).resolves.toMatchObject({
    success: true,
    data: { recordId: 'r1', name: 'Renamed' },
  });
  const [input, init] = transport.mock.calls[1] ?? [];
  expect(new URL(String(input)).pathname).toBe('/v1/records/r1');
  expect(init?.method).toBe('PATCH');
  expect(init?.body).toBe('{"name":"Renamed"}');
  expect(init?.headers).toStrictEqual({ authorization: 'Bearer a.b.c', 'content-type': 'application/json' });
});

it('refuses a byte body for a JSON operation before sending it', async () => {
  const { client, transport } = connect();
  // @ts-expect-error A JSON operation takes no byte body.
  const call = client.renameRecord({ recordId: 'r1', name: 'Renamed' }, { body: new Uint8Array([1]) });
  await expect(call).rejects.toThrow(new TypeError('A JSON operation cannot accept a binary body.'));
  expect(requestedPaths(transport)).toEqual(['/openapi.json']);
});

it('uploads bytes with the header-mapped fields in headers and the other fields in the query', async () => {
  const { client, transport } = connect();
  const result = await client.uploadFile(
    { fileId: 'f1', contentType: 'text/plain', checksum: 'c1', label: 'notes' },
    { body: new TextEncoder().encode('hello') }
  );
  expect(result).toMatchObject({
    success: true,
    data: { fileId: 'f1', bytes: 5, contentType: 'text/plain', checksum: 'c1', label: 'notes' },
  });
  const [input, init] = transport.mock.calls[1] ?? [];
  const sent = new URL(String(input));
  expect(`${sent.pathname}${sent.search}`).toBe('/v1/files/f1?label=notes');
  expect(init?.method).toBe('PUT');
  expect(init?.headers).toStrictEqual({
    authorization: 'Bearer a.b.c',
    'content-type': 'text/plain',
    'x-checksum': 'c1',
  });
});

it.each([
  ['a typed Blob', new Blob(['png'], { type: 'image/png' }), 'image/png'],
  ['an untyped Blob', new Blob(['raw']), 'application/octet-stream'],
  ['a Uint8Array', new Uint8Array([1, 2, 3]), 'application/octet-stream'],
])('labels an upload of %s without a mapped content type as %s', async (_name, body, contentType) => {
  const { client, transport } = connect();
  await expect(client.uploadFile({ fileId: 'f1' }, { body })).resolves.toMatchObject({
    success: true,
    data: { fileId: 'f1', bytes: 3, contentType },
  });
  expect(transport.mock.calls[1]?.[1]?.headers).toMatchObject({ 'content-type': contentType });
});

it('leaves undefined upload fields out of the query and the headers', async () => {
  const { client, transport } = connect();
  await expect(
    client.uploadFile({ fileId: 'f1', checksum: undefined, label: undefined }, { body: new Uint8Array([1]) })
  ).resolves.toMatchObject({ success: true, data: { fileId: 'f1', bytes: 1 } });
  const [input, init] = transport.mock.calls[1] ?? [];
  expect(new URL(String(input)).search).toBe('');
  expect(init?.headers).not.toHaveProperty('x-checksum');
});

it('refuses an upload without bytes, or with metadata that is not text, before sending it', async () => {
  const { client, transport } = connect();
  const body = new Uint8Array([1]);
  // @ts-expect-error An upload takes its bytes.
  const withoutOptions = client.uploadFile({ fileId: 'f1' });
  // @ts-expect-error An upload takes its bytes, not only a signal.
  const withoutBody = client.uploadFile({ fileId: 'f1' }, { signal: new AbortController().signal });
  // @ts-expect-error The bytes are a Blob or a Uint8Array.
  const withText = client.uploadFile({ fileId: 'f1' }, { body: 'hello' });
  await expect(withoutOptions).rejects.toThrow(new TypeError('A binary body is required.'));
  await expect(withoutBody).rejects.toThrow(new TypeError('A binary body is required.'));
  await expect(withText).rejects.toThrow(new TypeError('A binary body is required.'));
  // @ts-expect-error The query fields of an upload are strings.
  const numberedLabel = client.uploadFile({ fileId: 'f1', label: 7 }, { body });
  await expect(numberedLabel).rejects.toThrow(new TypeError('Query values must be strings.'));
  // @ts-expect-error Header-mapped fields are strings.
  const numberedChecksum = client.uploadFile({ fileId: 'f1', checksum: 7 }, { body });
  await expect(numberedChecksum).rejects.toThrow(new TypeError('Header values must be strings.'));
  expect(requestedPaths(transport)).toEqual(['/openapi.json']);
});

it('reports the start of an upload and its validated end, never a refused upload as complete', async () => {
  const { client } = connect();
  const progress = vi.fn();
  await expect(
    client.uploadFile({ fileId: 'f1' }, { body: new Uint8Array([1, 2]), onUploadProgress: progress })
  ).resolves.toMatchObject({ success: true });
  expect(progress.mock.calls).toEqual([[0], [1]]);
  progress.mockClear();
  await expect(
    client.uploadFile(
      { fileId: 'f1', checksum: 'mismatch' },
      { body: new Uint8Array([1]), onUploadProgress: progress }
    )
  ).resolves.toMatchObject({ success: false, error: { code: 'CHECKSUM_MISMATCH' } });
  expect(progress.mock.calls).toEqual([[0]]);
});

it('completes an upload whose progress observer throws, without sending it again', async () => {
  const { client, transport } = connect();
  const observer = vi.fn(() => {
    throw new Error('The observer failed.');
  });
  await expect(
    client.uploadFile({ fileId: 'f1' }, { body: new Uint8Array([1]), onUploadProgress: observer })
  ).resolves.toMatchObject({ success: true, data: { bytes: 1 } });
  expect(observer).toHaveBeenCalledTimes(2);
  expect(requestedPaths(transport)).toEqual(['/openapi.json', '/v1/files/f1']);
});

it('keeps the bearer and the input-mapped headers whatever beforeRequest sets', async () => {
  const { client, transport } = connect({
    beforeRequest: (request) => {
      request.headers.set('x-trace', 'trace-1');
      request.headers.set('authorization', 'Bearer forged');
      request.headers.set('x-checksum', 'forged');
      request.headers.set('content-type', 'text/html');
    },
  });
  await expect(
    client.uploadFile({ fileId: 'f1', checksum: 'c1' }, { body: new Blob(['hi'], { type: 'text/plain' }) })
  ).resolves.toMatchObject({ success: true, data: { checksum: 'c1', contentType: 'text/plain' } });
  expect(transport.mock.calls[1]?.[1]?.headers).toStrictEqual({
    authorization: 'Bearer a.b.c',
    'content-type': 'text/plain',
    'x-checksum': 'c1',
    'x-trace': 'trace-1',
  });
});

it('sends discovery without a bearer, even one that beforeRequest adds', async () => {
  const { client, transport } = connect({
    beforeRequest: (request) => {
      request.headers.set('authorization', 'Bearer forged');
      request.headers.set('x-trace', 'trace-1');
    },
  });
  await expect(client.getRecord({ recordId: 'r1' })).resolves.toMatchObject({ success: true });
  expect(transport.mock.calls.map(([, init]) => init?.headers)).toStrictEqual([
    { 'x-trace': 'trace-1' },
    { authorization: 'Bearer a.b.c', 'x-trace': 'trace-1' },
  ]);
});

it('hands afterResponse each response with the same request that beforeRequest saw', async () => {
  const beforeRequest = vi.fn<(request: Request) => void>();
  const afterResponse = vi.fn<(response: Response, request: Request) => void>();
  const { client } = connect({ beforeRequest, afterResponse });
  await expect(client.getRecord({ recordId: 'r1' })).resolves.toMatchObject({ success: true });
  expect(afterResponse).toHaveBeenCalledTimes(2);
  const [discovery, call] = afterResponse.mock.calls;
  expect(discovery?.[1]).toBe(beforeRequest.mock.calls[0]?.[0]);
  expect(call?.[1]).toBe(beforeRequest.mock.calls[1]?.[0]);
  expect(discovery?.[0].status).toBe(200);
  expect(new URL(call?.[1].url ?? '').pathname).toBe('/v1/records/r1');
  // The request carries the headers the client admitted, the bearer included.
  expect(call?.[1].headers.get('authorization')).toBe('Bearer a.b.c');
  expect(call?.[0].headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
});

it('sends the Fetch credentials and cache modes it is given, else omit and no-store', async () => {
  const modes = (transport: ReturnType<typeof vi.fn<typeof fetch>>) =>
    transport.mock.calls.map(([, init]) => [init?.credentials, init?.cache]);
  const defaults = connect();
  await defaults.client.getRecord({ recordId: 'r1' });
  expect(modes(defaults.transport)).toEqual([
    ['omit', 'no-store'],
    ['omit', 'no-store'],
  ]);
  const configured = connect({ credentials: 'include', cache: 'no-cache' });
  await configured.client.getRecord({ recordId: 'r1' });
  expect(modes(configured.transport)).toEqual([
    ['include', 'no-cache'],
    ['include', 'no-cache'],
  ]);
});

it('refuses a call whose signal has already aborted, before discovery', async () => {
  const { client, transport } = connect();
  const reason = new Error('The caller left.');
  await expect(client.getRecord({ recordId: 'r1' }, { signal: AbortSignal.abort(reason) })).rejects.toBe(
    reason
  );
  expect(transport).not.toHaveBeenCalled();
});

it('stops waiting for a shared discovery when its caller aborts, while another call still uses it', async () => {
  const handle = createHttpHandler(app, { verify });
  const contract = gate();
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    if (new URL(String(input)).pathname === '/openapi.json') {
      await contract.opened;
    }
    return handle(new Request(input, init), {});
  });
  const client = createClient<typeof app>(app.origin, 'a.b.c', { fetch: transport });
  const caller = new AbortController();
  const reason = new Error('The caller left.');
  const leaving = client.getRecord({ recordId: 'r1' }, { signal: caller.signal });
  const staying = client.getRecord({ recordId: 'r2' });
  caller.abort(reason);
  await expect(leaving).rejects.toBe(reason);
  contract.open();
  await expect(staying).resolves.toMatchObject({ success: true, data: { recordId: 'r2' } });
  expect(requestedPaths(transport)).toEqual(['/openapi.json', '/v1/records/r2']);
});

it('stops waiting for a token when the call is cancelled, and sends nothing', async () => {
  const handle = createHttpHandler(app, { verify });
  const transport = vi.fn<typeof fetch>(async (input, init) => handle(new Request(input, init), {}));
  const never = gate();
  const token = vi.fn(async () => {
    await never.opened;
    return 'a.b.c';
  });
  const client = createClient<typeof app>(app.origin, token, { fetch: transport });
  const caller = new AbortController();
  const reason = new Error('The caller left.');
  const call = client.getRecord({ recordId: 'r1' }, { signal: caller.signal });
  await vi.waitFor(() => expect(token).toHaveBeenCalledOnce());
  caller.abort(reason);
  await expect(call).rejects.toBe(reason);
  expect(requestedPaths(transport)).toEqual(['/openapi.json']);
});

it('captures the client signal once as each call starts, and cancels the call when it aborts', async () => {
  const handle = createHttpHandler(app, { verify });
  const answer = gate();
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    if (new URL(String(input)).pathname !== '/openapi.json') {
      await answer.opened;
    }
    return handle(new Request(input, init), {});
  });
  const lifecycle = new AbortController();
  const signal = vi.fn(() => lifecycle.signal);
  const client = createClient<typeof app>(app.origin, 'a.b.c', { fetch: transport, signal });
  const call = client.getRecord({ recordId: 'r1' });
  // Read before the call first awaits: discovery, the token and the request reuse it.
  expect(signal).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
  const reason = new Error('The page closed.');
  lifecycle.abort(reason);
  await expect(call).rejects.toBe(reason);
  expect(signal).toHaveBeenCalledOnce();
  await expect(client.getRecord({ recordId: 'r2' })).rejects.toBe(reason);
  expect(signal).toHaveBeenCalledTimes(2);
  answer.open();
});

it('gives up a call that outlasts the client deadline', async () => {
  const handle = createHttpHandler(app, { verify });
  const never = gate();
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    if (new URL(String(input)).pathname !== '/openapi.json') {
      await never.opened;
    }
    return handle(new Request(input, init), {});
  });
  // The deadline also bounds discovery, which answers at once; the operation itself never does.
  const client = createClient<typeof app>(app.origin, 'a.b.c', { fetch: transport, timeoutMs: 200 });
  await expect(client.getRecord({ recordId: 'r1' })).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(requestedPaths(transport)).toEqual(['/openapi.json', '/v1/records/r1']);
});

it('stops reading a response when the call is cancelled during its body', async () => {
  const handle = createHttpHandler(app, { verify });
  const caller = new AbortController();
  const reason = new Error('The caller left.');
  const transport = vi.fn<typeof fetch>(async (input, init) =>
    new URL(String(input)).pathname === '/openapi.json'
      ? handle(new Request(input, init), {})
      : new Response(
          // The caller leaves once the client starts reading the body.
          new ReadableStream<Uint8Array>({ pull: () => caller.abort(reason) }, { highWaterMark: 0 }),
          { headers: { 'content-type': 'application/json' } }
        )
  );
  const client = createClient<typeof app>(app.origin, 'a.b.c', { fetch: transport });
  await expect(client.getRecord({ recordId: 'r1' }, { signal: caller.signal })).rejects.toBe(reason);
});
