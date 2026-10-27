/**
 * The pages service in Node, over a stand-in for Browser Run: the hosts an address and Chrome's requests may
 * reach, a page read in Markdown and captured as a PNG, each way Browser Run can fail and the failure that
 * answers it, and read_page over MCP.
 */
import { beforeEach, expect, it, vi } from 'vite-plus/test';

import { handler } from '#maximus/http';

import { ALLOWED_REQUESTS, allowedUrl } from '../src/hosts.ts';

/** The development token `vp test` accepts from localhost, as a developer holding every scope. */
const token = 'test-development-token-for-local-tests';
/** Browser Run as the tests stand it in: its quick actions answer what each test says, and record each call. */
const quickAction = vi.fn<(action: string, options: object) => Promise<Response>>();
const env = { DEVELOPMENT_TOKEN: token, BROWSER: { quickAction } } as unknown as Env;

beforeEach(() => {
  quickAction.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

/** Calls the API with the development token and a JSON body. */
function call(path: string, body: object) {
  return handler(
    new Request(`http://localhost/api${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env
  );
}

/** Reads the page through the API, answering the status and the envelope. */
async function read(url: string) {
  const response = await call('/v1/pages/read', { url });
  return { status: response.status, body: (await response.json()) as { data: unknown; error: unknown } };
}

/** Browser Run's answer to a markdown action. */
const markdown = (result: unknown) => Response.json({ success: true, result });

it('opens only https addresses at the allowed hosts, and lets Chrome request nothing else', () => {
  for (const allowed of [
    'https://example.com/',
    'https://en.wikipedia.org/wiki/Aspirin',
    'https://www.who.int/news',
  ]) {
    expect(allowedUrl(allowed)?.href, allowed).toBe(allowed);
  }
  for (const refused of [
    'http://example.com/',
    'https://example.com:8443/',
    'https://user:secret@example.com/',
    'https://example.com.evil.test/',
    'https://wikipedia.org/',
    'https://evilwikipedia.org/',
    'https://127.0.0.1/',
    // oxlint-disable-next-line no-script-url -- an address the service must refuse.
    'javascript:alert(1)',
    'not an address',
  ]) {
    expect(allowedUrl(refused), refused).toBeUndefined();
  }
  const requested = (url: string) => ALLOWED_REQUESTS.some((pattern) => new RegExp(pattern).test(url));
  for (const allowed of [
    'https://example.com/',
    'https://example.com?q=1',
    'https://upload.en.wikipedia.org/a.png',
  ]) {
    expect(requested(allowed), allowed).toBe(true);
  }
  for (const refused of [
    'http://example.com/',
    'https://example.com:444/',
    'https://example.com.evil.test/',
    'https://example.com@evil.test/',
    'https://evil.test/?next=https://example.com/',
    'https://evil.test/.wikipedia.org/',
    'https://wikipedia.org/',
  ]) {
    expect(requested(refused), refused).toBe(false);
  }
});

it('reads a page in Markdown, held to the allowed requests and to twenty thousand characters', async () => {
  quickAction.mockResolvedValueOnce(markdown(`# Example Domain\n\n${'x'.repeat(30_000)}`));
  const page = await read('https://example.com/');
  expect(page).toMatchObject({ status: 200, body: { data: { url: 'https://example.com/' } } });
  const { markdown: text } = page.body.data as { markdown: string };
  expect(text).toHaveLength(20_000);
  expect(text.startsWith('# Example Domain')).toBe(true);
  expect(quickAction).toHaveBeenCalledExactlyOnceWith(
    'markdown',
    expect.objectContaining({ url: 'https://example.com/', allowRequestPattern: [...ALLOWED_REQUESTS] })
  );
});

it('refuses an address it may not open without starting Chrome', async () => {
  expect(await read('https://evil.test/')).toMatchObject({
    status: 422,
    body: { error: { code: 'HOST_NOT_ALLOWED' } },
  });
  expect(quickAction).not.toHaveBeenCalled();
});

it('answers each way Browser Run fails with the failure a caller can act on', async () => {
  quickAction
    .mockResolvedValueOnce(Response.json({ success: false, errors: [] }, { status: 422 }))
    .mockResolvedValueOnce(Response.json({ success: false, errors: [] }, { status: 429 }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockRejectedValueOnce(new Error('Network connection lost.'))
    .mockResolvedValueOnce(Response.json({ success: false, errors: [] }, { status: 400 }))
    .mockResolvedValueOnce(Response.json({ success: true }));
  for (const [status, code] of [
    [422, 'PAGE_NOT_LOADED'],
    [503, 'UPSTREAM_UNAVAILABLE'],
    [503, 'UPSTREAM_UNAVAILABLE'],
    [503, 'UPSTREAM_UNAVAILABLE'],
    // A request Browser Run finds malformed, or an answer this service cannot read, is the service's own fault.
    [500, 'INTERNAL_ERROR'],
    [500, 'INTERNAL_ERROR'],
  ] as const) {
    expect(await read('https://example.com/')).toMatchObject({ status, body: { error: { code } } });
  }
});

it('captures a page as a PNG attachment, and refuses an image that is not one or is too large', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  quickAction
    .mockResolvedValueOnce(new Response(png, { headers: { 'content-type': 'image/png' } }))
    .mockResolvedValueOnce(new Response('<html></html>', { headers: { 'content-type': 'text/html' } }))
    .mockResolvedValueOnce(
      new Response(new Uint8Array(1), {
        headers: { 'content-type': 'image/png', 'content-length': String(9 * 1024 * 1024) },
      })
    );
  const captured = await call('/v1/pages/screenshot', {
    url: 'https://example.com/',
    width: 800,
    fullPage: true,
  });
  expect(captured.status).toBe(200);
  expect(captured.headers.get('content-type')).toBe('image/png');
  expect(captured.headers.get('content-disposition')).toContain('example.com.png');
  expect(new Uint8Array(await captured.arrayBuffer())).toEqual(png);
  expect(quickAction).toHaveBeenCalledWith(
    'screenshot',
    expect.objectContaining({
      viewport: { width: 800, height: 800 },
      screenshotOptions: { type: 'png', fullPage: true },
    })
  );
  expect((await call('/v1/pages/screenshot', { url: 'https://example.com/' })).status).toBe(500);
  expect(await (await call('/v1/pages/screenshot', { url: 'https://example.com/' })).json()).toMatchObject({
    error: { code: 'PAGE_NOT_LOADED' },
  });
});

it('serves read_page over MCP, and the screenshot over HTTP alone', async () => {
  quickAction.mockResolvedValueOnce(markdown('# Example Domain'));
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
    'read_page',
  ]);
  expect(
    await rpc('tools/call', { name: 'read_page', arguments: { url: 'https://example.com/' } })
  ).toMatchObject({
    structuredContent: { markdown: '# Example Domain' },
  });
});
