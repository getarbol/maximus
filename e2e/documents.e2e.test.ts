/**
 * The R2 example running: a document uploaded as bytes comes back exactly, as an attachment.
 */
import { describe, expect, it } from 'vite-plus/test';

import { call, data, required, service } from './services.ts';
import { publicSurface } from './surface.ts';

publicSurface('documents', { method: 'POST', path: '/v1/documents', mcp: true });

describe.runIf(service('documents')?.token)('documents: signed in', () => {
  it('uploads a document, downloads the same bytes and deletes it', async () => {
    const worker = required('documents');
    const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
    const document = await data<{ documentId: string; byteLength: number }>(
      call(worker, '/api/v1/documents?filename=referral.pdf', {
        method: 'POST',
        headers: { 'content-type': 'application/pdf' },
        body: pdf,
      })
    );
    expect(document.byteLength).toBe(pdf.byteLength);
    const download = await call(worker, `/api/v1/documents/${document.documentId}/content`);
    expect(download.headers.get('content-disposition')).toContain('referral.pdf');
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(pdf);
    expect(
      (await call(worker, `/api/v1/documents/${document.documentId}`, { method: 'DELETE' })).status
    ).toBe(200);
  });
});
