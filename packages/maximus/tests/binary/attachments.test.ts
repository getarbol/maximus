/**
 * Attachment outputs: the schema that declares them, the checks a handler's file passes before anything
 * is sent, and the response that serves it with its exact length and headers that keep it inert.
 */
import { expect, it } from 'vite-plus/test';

import { attachmentResponse, isAttachmentSchema, validAttachment } from '../../src/binary.ts';
import { AttachmentOutputSchema, createHttpHandler, defineErrors, maximus, ok, t } from '../../src/index.ts';
import type { Attachment } from '../../src/index.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The bytes of a short text. */
const bytes = (text: string) => new TextEncoder().encode(text);
const file: Attachment = {
  body: bytes('hello'),
  contentType: 'text/plain',
  filename: 'notes.txt',
  byteLength: 5,
};

/** A stream that a reader already holds. */
function lockedStream(): ReadableStream<Uint8Array> {
  const stream = new Blob(['hello']).stream();
  stream.getReader();
  return stream;
}

it('recognizes AttachmentOutputSchema, which OpenAPI describes as binary text', () => {
  expect(isAttachmentSchema(AttachmentOutputSchema)).toBe(true);
  expect(AttachmentOutputSchema).toMatchObject({ type: 'string', format: 'binary' });
  expect(isAttachmentSchema(t.String({ format: 'binary' }))).toBe(false);
  expect(isAttachmentSchema(t.Object({}, { additionalProperties: false }))).toBe(false);
});

it.each([
  ['bytes', file],
  ['an unlocked stream', { ...file, body: new Blob(['hello']).stream() }],
  ['no bytes at all', { ...file, body: new Uint8Array(0), byteLength: 0 }],
  ['a structured media type', { ...file, contentType: 'application/vnd.api+json' }],
  ['a name in any script, with spaces and quotes', { ...file, filename: 'Résumé "final" 2026.pdf' }],
  [
    'the longest media type and name',
    { ...file, contentType: `text/${'x'.repeat(250)}`, filename: 'n'.repeat(512) },
  ],
])('accepts a file with %s', (_name, value) => {
  expect(validAttachment(value, 5)).toBe(true);
});

it.each([
  ['nothing', null],
  ['text', 'hello'],
  ['a missing field', { body: bytes('hello'), contentType: 'text/plain', filename: 'notes.txt' }],
  ['an extra field', { ...file, disposition: 'inline' }],
  ['a renamed field', { body: bytes('hello'), contentType: 'text/plain', name: 'notes.txt', byteLength: 5 }],
  ['a text body', { ...file, body: 'hello' }],
  ['a Blob body', { ...file, body: new Blob(['hello']) }],
  ['a stream a reader holds', { ...file, body: lockedStream() }],
  ['a negative length', { ...file, body: new Uint8Array(0), byteLength: -1 }],
  ['a fractional length', { ...file, byteLength: 4.5 }],
  ['a length written as text', { ...file, byteLength: '5' }],
  ['a length above the limit', { ...file, body: bytes('hello!'), byteLength: 6 }],
  ['a length its bytes do not have', { ...file, byteLength: 4 }],
  ['a media type that is not text', { ...file, contentType: 7 }],
  ['a media type without a subtype', { ...file, contentType: 'text' }],
  ['a media type with parameters', { ...file, contentType: 'text/plain; charset=utf-8' }],
  ['a media type longer than 255 characters', { ...file, contentType: `text/${'x'.repeat(251)}` }],
  ['an empty name', { ...file, filename: '' }],
  ['a name longer than 512 characters', { ...file, filename: 'n'.repeat(513) }],
  ['a name with a slash', { ...file, filename: '../notes.txt' }],
  ['a name with a backslash', { ...file, filename: String.raw`..\notes.txt` }],
  ['a name with a control character', { ...file, filename: 'notes\r\n.txt' }],
  ['a name that is not text', { ...file, filename: 7 }],
  ['a name with a lone surrogate', { ...file, filename: 'notes\uD800.txt' }],
])('refuses a file with %s', (_name, value) => {
  expect(validAttachment(value, 5)).toBe(false);
});

it('serves bytes with their length, media type and headers that keep the file inert', async () => {
  const response = attachmentResponse(file);
  expect(response.status).toBe(200);
  expect(Object.fromEntries(response.headers)).toStrictEqual({
    'cache-control': 'private, no-store',
    'content-type': 'text/plain',
    'content-length': '5',
    'content-disposition': `attachment; filename="notes.txt"; filename*=UTF-8''notes.txt`,
    'content-security-policy': "default-src 'none'; sandbox",
    'x-content-type-options': 'nosniff',
  });
  expect(await response.text()).toBe('hello');
});

it('answers with the success status it is given', () => {
  expect(attachmentResponse(file, 201).status).toBe(201);
});

it.each([
  [
    'Résumé "final" (v2).pdf',
    `attachment; filename="R_sum_ _final_ (v2).pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%22final%22%20%28v2%29.pdf`,
  ],
  ["it's done!*.txt", `attachment; filename="it's done!*.txt"; filename*=UTF-8''it%27s%20done%21%2A.txt`],
  ['報告.txt', `attachment; filename="__.txt"; filename*=UTF-8''%E5%A0%B1%E5%91%8A.txt`],
  ['📄 report.pdf', `attachment; filename="_ report.pdf"; filename*=UTF-8''%F0%9F%93%84%20report.pdf`],
])('names %s with an ASCII fallback and its RFC 8187 form', (filename, disposition) => {
  expect(attachmentResponse({ ...file, filename }).headers.get('content-disposition')).toBe(disposition);
});

it('holds a streamed body to its declared length', async () => {
  const exact = attachmentResponse({ ...file, body: new Blob(['hello']).stream() });
  expect(exact.headers.get('content-length')).toBe('5');
  expect(await exact.text()).toBe('hello');
  const longer = attachmentResponse({ ...file, body: new Blob(['hello world']).stream() });
  await expect(longer.text()).rejects.toThrow(new TypeError('A byte stream exceeds its declared length.'));
  const shorter = attachmentResponse({ ...file, body: new Blob(['hell']).stream() });
  await expect(shorter.text()).rejects.toThrow(
    new TypeError('A byte stream ended before its declared length.')
  );
});

/** The file each identifier makes the download operation answer. */
const files: Record<string, Attachment> = {
  notes: file,
  streamed: { ...file, body: new Blob(['hello']).stream() },
  traversal: { ...file, filename: '../secrets.txt' },
  oversized: { ...file, body: bytes('hello!'), byteLength: 6 },
  mismatched: { ...file, byteLength: 4 },
};
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
    'downloadFile',
    {
      scope: 'files:files:read',
      title: 'Download a file',
      description: 'Download one file.',
      effect: 'read',
      maxOutputBytes: 5,
      http: { method: 'GET', path: '/v1/files/{fileId}', response: 'attachment' },
      input: t.Object({ fileId: t.String() }, { additionalProperties: false }),
      output: AttachmentOutputSchema,
    },
    async (_context, input) => ok(files[input.fileId] ?? file)
  )
  .build();
const handle = createHttpHandler(app, {
  verify: async () => ({
    sub: 'client@clients',
    client_id: 'client',
    org_id: 'org_1234567890abcdef',
    scope: 'files:files:read',
  }),
});
/** Downloads one file from the service. */
async function download(fileId: string): Promise<Response> {
  return await handle(
    new Request(`https://files.example.test/v1/files/${fileId}`, {
      headers: { authorization: 'Bearer a.b.c' },
    }),
    {}
  );
}

it.each(['notes', 'streamed'])(
  'serves the %s file of an attachment operation with its request id',
  async (fileId) => {
    const response = await download(fileId);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(response.headers.get('content-length')).toBe('5');
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="notes.txt"; filename*=UTF-8''notes.txt`
    );
    expect(response.headers.get('x-request-id')).toMatch(UUID);
    expect(await response.text()).toBe('hello');
  }
);

it.each(['traversal', 'oversized', 'mismatched'])(
  'answers INTERNAL_ERROR instead of the %s file a handler returns',
  async (fileId) => {
    const response = await download(fileId);
    expect(response.status).toBe(500);
    expect(response.headers.get('content-disposition')).toBeNull();
    expect(await response.json()).toMatchObject({
      success: false,
      data: null,
      error: { code: 'INTERNAL_ERROR' },
    });
  }
);
