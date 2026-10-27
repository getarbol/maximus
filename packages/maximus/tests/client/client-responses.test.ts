/**
 * What a typed client call answers: a refusal as its typed envelope, or in data mode as a thrown error
 * the application may present; malformed, mismatched and oversized answers refused; and attachments
 * handed out as Responses held to their declared length.
 */
import { expect, it, vi } from 'vite-plus/test';

import { createClient } from '../../src/client/client.ts';
import type { ClientFailure } from '../../src/client/client.ts';
import {
  AttachmentOutputSchema,
  createHttpHandler,
  defineErrors,
  err,
  maximus,
  ok,
  t,
} from '../../src/index.ts';

const errors = defineErrors({
  recordLocked: { code: 'RECORD_LOCKED', status: 409, message: 'The record is locked.', retryable: true },
  fileMissing: { code: 'FILE_MISSING', status: 404, message: 'The file does not exist.' },
});
const schema = t.Object({ documentNumber: t.String() }, { additionalProperties: false });
const app = maximus<Record<string, never>>({
  name: 'demo',
  namespace: 'demo',
  title: 'Demo',
  version: '2',
  origin: 'https://example.test',
  tokens: { issuer: 'https://issuer.example.test/', audience: 'demo' },
  errors,
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
    async (_context, input) =>
      input.documentNumber === 'locked' ? err(errors.recordLocked.create()) : ok(input)
  )
  .operation(
    'downloadFile',
    {
      scope: 'demo:files:read',
      title: 'Download a file',
      description: 'Download one file.',
      effect: 'read',
      http: { method: 'GET', path: '/v1/files/{fileId}', response: 'attachment' },
      input: t.Object({ fileId: t.String() }, { additionalProperties: false }),
      output: AttachmentOutputSchema,
    },
    async (_context, input) =>
      input.fileId === 'notes'
        ? ok({
            body: new TextEncoder().encode('hello'),
            contentType: 'text/plain',
            filename: 'notes.txt',
            byteLength: 5,
          })
        : err(errors.fileMissing.create())
  )
  .build();
const verify = async () => ({
  sub: 'client@clients',
  client_id: 'client',
  org_id: 'org_1234567890abcdef',
  scope: 'demo:records:read demo:files:read',
});
const REQUEST_ID = '0b5e1c9a-3f2d-4e8b-9c1a-7d6e5f4a3b2c';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCKED = { code: 'RECORD_LOCKED', message: 'The record is locked.', retryable: true, data: {} };
const INTERNAL = {
  code: 'INTERNAL_ERROR',
  message: 'The service could not complete the operation.',
  retryable: false,
  data: {},
};

/** The in-process service as the client's fetch. */
function serve() {
  const handle = createHttpHandler(app, { verify });
  return vi.fn<typeof fetch>(async (input, init) => handle(new Request(input, init), {}));
}
/** The service's own contract, with every operation answered by `answer` instead of the service. */
function answering(answer: () => Response) {
  const handle = createHttpHandler(app, { verify });
  return vi.fn<typeof fetch>(async (input, init) =>
    new URL(String(input)).pathname === '/openapi.json' ? handle(new Request(input, init), {}) : answer()
  );
}
/** A refusal envelope whose message pads its body to the given length, with its id also in its headers. */
function paddedRefusal(messageLength: number): Response {
  return Response.json(
    {
      success: false,
      data: null,
      error: { ...LOCKED, message: 'x'.repeat(messageLength) },
      metadata: { requestId: REQUEST_ID },
    },
    { status: 409, headers: { 'x-request-id': REQUEST_ID } }
  );
}
/** An answer whose body is not JSON, as a proxy in front of the service may send. */
function htmlAnswer(status: number, headers: Record<string, string> = {}): Response {
  return new Response('<html>Bad gateway</html>', {
    status,
    headers: { 'content-type': 'text/html', ...headers },
  });
}

it('answers a refusal with its typed failure envelope', async () => {
  const client = createClient<typeof app>(app.origin, 'a.b.c', { fetch: serve() });
  await expect(client.lookup({ documentNumber: 'locked' })).resolves.toStrictEqual({
    success: false,
    data: null,
    error: LOCKED,
    metadata: { requestId: expect.stringMatching(UUID) },
  });
});

it('rejects a refusal in data mode with an error that carries the refusal only as its cause', async () => {
  const client = createClient<typeof app>(app.origin, 'a.b.c', { fetch: serve(), response: 'data' });
  const call = client.lookup({ documentNumber: 'locked' });
  await expect(call).rejects.toThrow(new Error('The service refused the request.'));
  await expect(call).rejects.toHaveProperty('cause', {
    status: 409,
    failure: LOCKED,
    requestId: expect.stringMatching(UUID),
  });
});

it('throws the error onFailure presents for a refusal in data mode, and returns data otherwise', async () => {
  const presented = new Error('The record is locked; try again later.');
  const onFailure = vi.fn<(refusal: ClientFailure) => Error>(() => presented);
  const client = createClient<typeof app>(app.origin, 'a.b.c', {
    fetch: serve(),
    response: 'data',
    onFailure,
  });
  await expect(client.lookup({ documentNumber: 'locked' })).rejects.toBe(presented);
  expect(onFailure).toHaveBeenCalledWith({
    status: 409,
    failure: LOCKED,
    requestId: expect.stringMatching(UUID),
  });
  await expect(client.lookup({ documentNumber: '123' })).resolves.toStrictEqual({ documentNumber: '123' });
  expect(onFailure).toHaveBeenCalledOnce();
});

it.each([
  ['its request id', { 'x-request-id': REQUEST_ID }, REQUEST_ID],
  ['its edge ray id', { 'x-request-id': '8f3b2a1c4d5e6f70-IAD' }, '8f3b2a1c4d5e6f70-IAD'],
  ['no request id for an id that is not one', { 'x-request-id': 'forged <id>' }, ''],
  ['no request id when there is none', {}, ''],
])(
  'presents an unreadable refusal in data mode as INTERNAL_ERROR with its real status and %s',
  async (_name, headers, requestId) => {
    const onFailure = vi.fn<(refusal: ClientFailure) => Error>(() => new Error('Presented.'));
    const client = createClient<typeof app>(app.origin, 'a.b.c', {
      fetch: answering(() => htmlAnswer(502, headers)),
      response: 'data',
      onFailure,
    });
    await expect(client.lookup({ documentNumber: '123' })).rejects.toThrow('Presented.');
    expect(onFailure).toHaveBeenCalledWith({ status: 502, failure: INTERNAL, requestId });
  }
);

it('refuses an unreadable refusal in envelope mode', async () => {
  const client = createClient<typeof app>(app.origin, 'a.b.c', { fetch: answering(() => htmlAnswer(502)) });
  await expect(client.lookup({ documentNumber: '123' })).rejects.toThrow(
    new Error('Invalid service response (502).')
  );
});

it('reads a refusal body of at most 16 KiB, whatever the success limit', async () => {
  const fits = createClient<typeof app>(app.origin, 'a.b.c', {
    fetch: answering(() => paddedRefusal(16_000)),
  });
  await expect(fits.lookup({ documentNumber: '123' })).resolves.toMatchObject({
    success: false,
    error: { code: 'RECORD_LOCKED' },
  });
  const tooLarge = createClient<typeof app>(app.origin, 'a.b.c', {
    fetch: answering(() => paddedRefusal(16 * 1024)),
  });
  await expect(tooLarge.lookup({ documentNumber: '123' })).rejects.toThrow('Invalid service response (409).');
  const onFailure = vi.fn<(refusal: ClientFailure) => Error>(() => new Error('Presented.'));
  const dataMode = createClient<typeof app>(app.origin, 'a.b.c', {
    fetch: answering(() => paddedRefusal(16 * 1024)),
    response: 'data',
    onFailure,
  });
  await expect(dataMode.lookup({ documentNumber: '123' })).rejects.toThrow('Presented.');
  expect(onFailure).toHaveBeenCalledWith({ status: 409, failure: INTERNAL, requestId: REQUEST_ID });
});

it('refuses a streamed success larger than maxResponseBytes, even in data mode', async () => {
  const client = createClient<typeof app>(app.origin, 'a.b.c', {
    fetch: serve(),
    response: 'data',
    maxResponseBytes: 128,
  });
  await expect(client.lookup({ documentNumber: '123' })).resolves.toStrictEqual({ documentNumber: '123' });
  await expect(client.lookup({ documentNumber: 'x'.repeat(64) })).rejects.toThrow(
    'Invalid service response (200).'
  );
});

it.each([
  [
    'a refusal envelope answered as a success',
    () => Response.json({ success: false, data: null, error: LOCKED, metadata: { requestId: REQUEST_ID } }),
    200,
  ],
  [
    'a success envelope without its request id',
    () => Response.json({ success: true, data: { documentNumber: '123' }, error: null, metadata: {} }),
    200,
  ],
  ['an empty answer', () => new Response(null, { status: 204 }), 204],
  ['a body that is not JSON', () => new Response('ok', { headers: { 'content-type': 'text/plain' } }), 200],
])('refuses %s in data mode instead of returning data', async (_name, answer, status) => {
  const onFailure = vi.fn<(refusal: ClientFailure) => Error>();
  const client = createClient<typeof app>(app.origin, 'a.b.c', {
    fetch: answering(answer),
    response: 'data',
    onFailure,
  });
  await expect(client.lookup({ documentNumber: '123' })).rejects.toThrow(
    new Error(`Invalid service response (${status}).`)
  );
  expect(onFailure).not.toHaveBeenCalled();
});

it('presents a success envelope answered with a refusal status as a refusal in data mode', async () => {
  const success = () =>
    Response.json(
      { success: true, data: { documentNumber: '123' }, error: null, metadata: { requestId: REQUEST_ID } },
      { status: 409 }
    );
  const envelopes = createClient<typeof app>(app.origin, 'a.b.c', { fetch: answering(success) });
  await expect(envelopes.lookup({ documentNumber: '123' })).rejects.toThrow(
    'Invalid service response (409).'
  );
  const onFailure = vi.fn<(refusal: ClientFailure) => Error>(() => new Error('Presented.'));
  const data = createClient<typeof app>(app.origin, 'a.b.c', {
    fetch: answering(success),
    response: 'data',
    onFailure,
  });
  await expect(data.lookup({ documentNumber: '123' })).rejects.toThrow('Presented.');
  expect(onFailure).toHaveBeenCalledWith({ status: 409, failure: INTERNAL, requestId: '' });
});

it('answers an attachment in data mode as a Response with its bytes and headers', async () => {
  const client = createClient<typeof app>(app.origin, 'a.b.c', { fetch: serve(), response: 'data' });
  const file = await client.downloadFile({ fileId: 'notes' });
  expect(file).toBeInstanceOf(Response);
  expect(file.status).toBe(200);
  expect(file.headers.get('content-type')).toBe('text/plain');
  expect(file.headers.get('content-length')).toBe('5');
  expect(file.headers.get('content-disposition')).toBe(
    `attachment; filename="notes.txt"; filename*=UTF-8''notes.txt`
  );
  expect(await file.text()).toBe('hello');
});

it('wraps an attachment in a success envelope with the request id of its response', async () => {
  const client = createClient<typeof app>(app.origin, 'a.b.c', { fetch: serve() });
  const result = await client.downloadFile({ fileId: 'notes' });
  if (!result.success) {
    throw new Error('The download was refused.');
  }
  expect(result.error).toBeNull();
  expect(result.metadata.requestId).toMatch(UUID);
  expect(result.metadata.requestId).toBe(result.data.headers.get('x-request-id'));
  expect(await result.data.text()).toBe('hello');
});

it('gives an attachment envelope an empty request id when its response has none', async () => {
  const client = createClient<typeof app>(app.origin, 'a.b.c', {
    fetch: answering(() => new Response('hello', { headers: { 'content-length': '5' } })),
  });
  await expect(client.downloadFile({ fileId: 'notes' })).resolves.toMatchObject({
    success: true,
    error: null,
    metadata: { requestId: '' },
  });
});

it('answers an attachment refusal with its failure envelope, or rejects it in data mode', async () => {
  const envelopes = createClient<typeof app>(app.origin, 'a.b.c', { fetch: serve() });
  await expect(envelopes.downloadFile({ fileId: 'missing' })).resolves.toMatchObject({
    success: false,
    data: null,
    error: { code: 'FILE_MISSING' },
  });
  const data = createClient<typeof app>(app.origin, 'a.b.c', { fetch: serve(), response: 'data' });
  await expect(data.downloadFile({ fileId: 'missing' })).rejects.toHaveProperty('cause', {
    status: 404,
    failure: { code: 'FILE_MISSING', message: 'The file does not exist.', retryable: false, data: {} },
    requestId: expect.stringMatching(UUID),
  });
});

it('refuses an attachment above maxAttachmentBytes before reading it', async () => {
  const bounded = createClient<typeof app>(app.origin, 'a.b.c', {
    fetch: serve(),
    response: 'data',
    maxAttachmentBytes: 4,
  });
  await expect(bounded.downloadFile({ fileId: 'notes' })).rejects.toThrow('Invalid attachment length.');
  const exact = createClient<typeof app>(app.origin, 'a.b.c', {
    fetch: serve(),
    response: 'data',
    maxAttachmentBytes: 5,
  });
  expect(await (await exact.downloadFile({ fileId: 'notes' })).text()).toBe('hello');
});

it('refuses a streamed attachment that declares no length', async () => {
  const client = createClient<typeof app>(app.origin, 'a.b.c', {
    fetch: answering(() => new Response(new Blob(['hello']).stream())),
    response: 'data',
  });
  await expect(client.downloadFile({ fileId: 'notes' })).rejects.toThrow('Invalid attachment length.');
});

it('errors an attachment body that carries more bytes than it declares', async () => {
  const client = createClient<typeof app>(app.origin, 'a.b.c', {
    fetch: answering(() => new Response('hello world', { headers: { 'content-length': '5' } })),
    response: 'data',
  });
  const file = await client.downloadFile({ fileId: 'notes' });
  await expect(file.text()).rejects.toThrow('A byte stream exceeds its declared length.');
});
