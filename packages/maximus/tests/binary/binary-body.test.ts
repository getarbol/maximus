/**
 * The reader of a declared byte body: built without touching the request, read once on demand within
 * its byte limit, and refusing compressed, oversized, malformed or cancelled uploads with the standard
 * failures.
 */
import { expect, it } from 'vite-plus/test';

import { binaryBody } from '../../src/binary.ts';
import { createHttpHandler, defineErrors, maximus, ok, standardErrors, t } from '../../src/index.ts';

/** An upload of `body`, with its headers and, when given, its caller's signal. */
function upload(
  body: Uint8Array<ArrayBuffer> | null,
  headers: Record<string, string> = {},
  signal?: AbortSignal
) {
  return new Request('https://files.example.test/v1/files/f1', {
    method: 'PUT',
    body,
    headers,
    ...(signal ? { signal } : {}),
  });
}

it('touches no byte until the first read, and answers every read with the same result', async () => {
  const request = upload(new Uint8Array([1, 2, 3]));
  const body = binaryBody(request, 16);
  expect(request.bodyUsed).toBe(false);
  const first = body.read();
  expect(body.read()).toBe(first);
  await expect(first).resolves.toStrictEqual({ ok: true, value: new Uint8Array([1, 2, 3]) });
  expect(request.bodyUsed).toBe(true);
  expect(await body.read()).toBe(await first);
});

it('reads a body of exactly its limit', async () => {
  await expect(binaryBody(upload(new Uint8Array(16)), 16).read()).resolves.toStrictEqual({
    ok: true,
    value: new Uint8Array(16),
  });
});

it('reads an upload without a body as no bytes', async () => {
  await expect(binaryBody(upload(null), 16).read()).resolves.toStrictEqual({
    ok: true,
    value: new Uint8Array(0),
  });
});

it.each(['identity', 'IDENTITY', 'Identity'])(
  'reads a body whose content encoding is %s',
  async (encoding) => {
    await expect(
      binaryBody(upload(new Uint8Array([1]), { 'content-encoding': encoding }), 16).read()
    ).resolves.toStrictEqual({ ok: true, value: new Uint8Array([1]) });
  }
);

it.each(['gzip', 'br', 'deflate', 'identity, gzip'])(
  'refuses a %s-encoded upload as UNSUPPORTED_MEDIA_TYPE without reading it',
  async (encoding) => {
    const request = upload(new Uint8Array([1]), { 'content-encoding': encoding });
    await expect(binaryBody(request, 16).read()).resolves.toStrictEqual({
      ok: false,
      error: standardErrors.unsupportedMedia.create(),
    });
    expect(request.bodyUsed).toBe(false);
  }
);

it.each([
  [
    'declares more bytes than its limit',
    () => upload(new Uint8Array(17), { 'content-length': '17' }),
    standardErrors.tooLarge.create(),
  ],
  ['streams more bytes than its limit', () => upload(new Uint8Array(17)), standardErrors.tooLarge.create()],
  [
    'declares a malformed length',
    () => upload(new Uint8Array(3), { 'content-length': '3 bytes' }),
    standardErrors.invalidInput.create(),
  ],
  [
    'its caller cancelled',
    () => upload(new Uint8Array(3), {}, AbortSignal.abort()),
    standardErrors.invalidInput.create(),
  ],
])('refuses an upload that %s', async (_name, request, error) => {
  await expect(binaryBody(request(), 16).read()).resolves.toStrictEqual({ ok: false, error });
});

it('hands a byte operation its body within the operation limit, and refuses the rest', async () => {
  const app = maximus<Record<string, never>>({
    name: 'files',
    namespace: 'files',
    title: 'Files',
    version: '1',
    origin: 'https://files.example.test',
    tokens: { issuer: 'https://issuer.example.test/', audience: 'files' },
    errors: defineErrors({}),
    rpc: { callers: [] },
    telemetry: { enabled: false },
  })
    .operation(
      'uploadFile',
      {
        scope: 'files:files:write',
        title: 'Upload a file',
        description: 'Store the request body as a file.',
        effect: 'write',
        maxBodyBytes: 8,
        http: { method: 'PUT', path: '/v1/files/{fileId}', body: 'bytes' },
        input: t.Object({ fileId: t.String() }, { additionalProperties: false }),
        output: t.Object({ bytes: t.Integer() }, { additionalProperties: false }),
      },
      async ({ body }) => {
        const bytes = await body.read();
        return bytes.ok ? ok({ bytes: bytes.value.byteLength }) : bytes;
      }
    )
    .build();
  const handle = createHttpHandler(app, {
    verify: async () => ({
      sub: 'client@clients',
      client_id: 'client',
      org_id: 'org_1234567890abcdef',
      scope: 'files:files:write',
    }),
  });
  const put = async (bytes: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) => {
    const response = await handle(
      new Request('https://files.example.test/v1/files/f1', {
        method: 'PUT',
        body: bytes,
        headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/octet-stream', ...headers },
      }),
      {}
    );
    return { status: response.status, body: await response.json() };
  };
  expect(await put(new Uint8Array(8))).toMatchObject({ status: 200, body: { data: { bytes: 8 } } });
  expect(await put(new Uint8Array(9))).toMatchObject({
    status: 413,
    body: { error: { code: 'REQUEST_TOO_LARGE' } },
  });
  expect(await put(new Uint8Array(1), { 'content-encoding': 'gzip' })).toMatchObject({
    status: 415,
    body: { error: { code: 'UNSUPPORTED_MEDIA_TYPE' } },
  });
});
