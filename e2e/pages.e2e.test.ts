/**
 * The Browser Run example running, which needs the account's Browser Run even locally: a page read in
 * Markdown and captured as a PNG.
 */
import { describe, expect, it } from 'vite-plus/test';

import { call, data, required, service } from './services.ts';
import { publicSurface } from './surface.ts';

publicSurface('pages', { method: 'POST', path: '/v1/pages/read', mcp: true });

describe.runIf(service('pages')?.token)('pages: signed in', () => {
  it('reads a page in Markdown and captures it as a PNG', async () => {
    const worker = required('pages');
    const page = await data<{ markdown: string }>(
      call(worker, '/api/v1/pages/read', { method: 'POST', json: { url: 'https://example.com/' } })
    );
    expect(page.markdown).toContain('Example Domain');
    const image = await call(worker, '/api/v1/pages/screenshot', {
      method: 'POST',
      json: { url: 'https://example.com/' },
    });
    expect(image.headers.get('content-type')).toBe('image/png');
    expect([...new Uint8Array(await image.arrayBuffer()).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});
