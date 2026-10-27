/**
 * The documents service in Node, over an R2 stand-in: a document uploaded, described, downloaded and deleted;
 * the uploads it refuses, by size, encoding, name or bytes that do not match their type; and, through the
 * store, that one organization never reaches another's documents and that metadata its schema refuses is
 * never answered.
 */
import { beforeEach, expect, it, vi } from 'vite-plus/test';

import { handler } from '#maximus/http';

import { documentStore } from '../src/documents.ts';
import type { Document } from '../src/documents.ts';
import { testBucket } from './r2.ts';

/** The development token `vp test` accepts from localhost, as a developer holding every scope. */
const token = 'test-development-token-for-local-tests';
let r2: ReturnType<typeof testBucket>;
let env: Env;

beforeEach(() => {
  r2 = testBucket();
  env = { DEVELOPMENT_TOKEN: token, DOCUMENTS: r2.bucket } as Env;
  vi.restoreAllMocks();
});

/** A minimal PDF: what its signature checks. */
const PDF = new Uint8Array(new TextEncoder().encode('%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n%%EOF\n'));

/** Calls the API with the development token and these headers, sending `body` when there is one. */
function call(method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) {
  return handler(
    new Request(`http://localhost/api${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...headers },
      ...(body === undefined ? {} : { body }),
    }),
    env
  );
}

/** Uploads the bytes under this name and type, answering the status and the envelope. */
async function upload(bytes: BodyInit, filename: string, contentType: string, headers = {}) {
  const response = await call('POST', `/v1/documents?filename=${encodeURIComponent(filename)}`, bytes, {
    'content-type': contentType,
    ...headers,
  });
  return { status: response.status, body: (await response.json()) as { data: unknown; error: unknown } };
}

it('uploads a document, describes it, downloads it and deletes it', async () => {
  const created = await upload(PDF, 'Referral letter.pdf', 'application/pdf');
  expect(created).toMatchObject({
    status: 201,
    body: {
      data: { filename: 'Referral letter.pdf', contentType: 'application/pdf', byteLength: PDF.byteLength },
    },
  });
  const document = created.body.data as Document;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', PDF));
  expect(document.sha256).toBe(Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''));
  expect(await (await call('GET', `/v1/documents/${document.documentId}`)).json()).toMatchObject({
    data: document,
  });

  const download = await call('GET', `/v1/documents/${document.documentId}/content`);
  expect(download.status).toBe(200);
  expect(Object.fromEntries(download.headers)).toMatchObject({
    'content-type': 'application/pdf',
    'content-length': String(PDF.byteLength),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  });
  expect(download.headers.get('content-disposition')).toContain('Referral letter.pdf');
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(PDF);

  expect((await call('DELETE', `/v1/documents/${document.documentId}`)).status).toBe(200);
  for (const path of [
    `/v1/documents/${document.documentId}`,
    `/v1/documents/${document.documentId}/content`,
  ]) {
    expect(await (await call('GET', path)).json()).toMatchObject({ error: { code: 'DOCUMENT_NOT_FOUND' } });
  }
  expect((await call('DELETE', `/v1/documents/${document.documentId}`)).status).toBe(404);
});

it('accepts each format whose bytes match it, and only those', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]);
  const text = new TextEncoder().encode('Blood pressure 120/80, recheck in a month.');
  for (const [bytes, type] of [
    [png, 'image/png'],
    [jpeg, 'image/jpeg'],
    [text, 'text/plain; charset=utf-8'],
    [PDF, 'Application/PDF'],
  ] as const) {
    expect((await upload(bytes, 'file', type)).status, type).toBe(201);
  }
  for (const [bytes, type] of [
    [png, 'application/pdf'],
    [PDF, 'image/png'],
    [new TextEncoder().encode('<script>alert(1)</script>'), 'text/html'],
    [new Uint8Array([0x68, 0x69, 0, 0x21]), 'text/plain'],
    [new Uint8Array([0xc3, 0x28]), 'text/plain'],
    [new Uint8Array(0), 'text/plain'],
  ] as const) {
    expect(await upload(bytes, 'file', type), type).toMatchObject({
      status: 415,
      body: { error: { code: 'DOCUMENT_NOT_ACCEPTED' } },
    });
  }
  expect(r2.objects.size).toBe(4);
});

it('refuses a document past 10 MiB, a compressed one and a name it cannot keep, storing none', async () => {
  expect(await upload(new Uint8Array(10 * 1024 * 1024 + 1), 'scan.pdf', 'application/pdf')).toMatchObject({
    status: 413,
    body: { error: { code: 'REQUEST_TOO_LARGE' } },
  });
  expect(await upload(PDF, 'scan.pdf', 'application/pdf', { 'content-encoding': 'gzip' })).toMatchObject({
    status: 415,
    body: { error: { code: 'UNSUPPORTED_MEDIA_TYPE' } },
  });
  for (const filename of ['', '../secrets.pdf', 'a\\b.pdf', 'line\nbreak.pdf', 'x'.repeat(201)]) {
    expect((await upload(PDF, filename, 'application/pdf')).status, JSON.stringify(filename)).toBe(400);
  }
  expect(r2.objects.size).toBe(0);
});

it('keeps each organization to its own documents, and never answers metadata its schema refuses', async () => {
  const clinic = documentStore(r2.bucket, 'org_clinic');
  const lab = documentStore(r2.bucket, 'org_lab');
  const document = await clinic.create('result.pdf', 'application/pdf', PDF);
  expect(await lab.describe(document.documentId)).toBeUndefined();
  expect(await lab.open(document.documentId)).toBeUndefined();
  expect(await lab.remove(document.documentId)).toBe(false);
  expect(await clinic.describe(document.documentId)).toEqual(document);

  const mine = (await upload(PDF, 'visit.pdf', 'application/pdf')).body.data as Document;
  const stored = r2.objects.get(`documents/local-development/${mine.documentId}`);
  if (stored) {
    stored.customMetadata = { filename: 'visit.pdf' };
  }
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await call('GET', `/v1/documents/${mine.documentId}`)).toMatchObject({ status: 500 });
});

it('describes a document to agents over MCP, and never hands them its bytes', async () => {
  const document = (await upload(PDF, 'visit.pdf', 'application/pdf')).body.data as Document;
  const rpc = async (method: string, params: object) => {
    const response = await handler(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
      env
    );
    const text = await response.text();
    return (JSON.parse(/data: (\{[^\n]*)/u.exec(text)?.[1] ?? text) as { result: Record<string, unknown> })
      .result;
  };
  expect(((await rpc('tools/list', {})).tools as { name: string }[]).map(({ name }) => name)).toEqual([
    'get_document',
  ]);
  expect(
    await rpc('tools/call', { name: 'get_document', arguments: { documentId: document.documentId } })
  ).toMatchObject({ structuredContent: document });
});
