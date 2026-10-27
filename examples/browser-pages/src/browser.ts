/**
 * Pages through Browser Run's quick actions: Chrome, on Cloudflare's network, opens the page with every
 * request it makes held to the allowed hosts, and answers Markdown or a PNG. Its answers are read within
 * limits and checked before they are used.
 */
import { readBodyBytes, readJsonResponse, reportUnexpected, t } from '@arbol-ai/maximus';
import { checkSchema } from '@arbol-ai/maximus/schemas';

import { ALLOWED_REQUESTS } from './hosts.ts';

/** What rendering answers: the page as asked, or the failure that stopped it. */
export type Rendered<T> = { value: T } | { failure: 'PAGE_NOT_LOADED' | 'UPSTREAM_UNAVAILABLE' };

/** What every quick action is given: the page, its viewport, its load deadline and the requests it may make. */
function page(url: URL, width: number): BrowserRunBaseOptions & { url: string } {
  return {
    url: url.href,
    viewport: { width, height: 800 },
    gotoOptions: { waitUntil: 'load', timeout: 15_000 },
    allowRequestPattern: [...ALLOWED_REQUESTS],
  };
}

/**
 * The answer of a quick action that succeeded, or the failure it reports. Browser Run refuses a page that
 * does not load with 422 and a call over the account's limits with 429; a request it finds malformed is this
 * service's error, and throws.
 */
async function quickAction(run: () => Promise<Response>): Promise<Response | Rendered<never>> {
  let response: Response;
  try {
    response = await run();
  } catch (error) {
    reportUnexpected(error, 'browser');
    return { failure: 'UPSTREAM_UNAVAILABLE' };
  }
  if (response.ok) {
    return response;
  }
  void response.body?.cancel().catch(() => {});
  if (response.status === 422) {
    return { failure: 'PAGE_NOT_LOADED' };
  }
  if (response.status === 429 || response.status >= 500) {
    return { failure: 'UPSTREAM_UNAVAILABLE' };
  }
  throw new TypeError(`Browser Run refused the request with ${response.status}.`);
}

/** What the markdown action answers. */
const MarkdownAnswerSchema = t.Object({ success: t.Literal(true), result: t.String() });

/** The page as Markdown, at most `maxLength` characters of it. */
export async function pageMarkdown(
  browser: BrowserRun,
  url: URL,
  maxLength: number
): Promise<Rendered<string>> {
  const response = await quickAction(() => browser.quickAction('markdown', page(url, 1280)));
  if (!(response instanceof Response)) {
    return response;
  }
  const body = await readJsonResponse(response, {
    maxBytes: 2 * 1024 * 1024,
    signal: AbortSignal.timeout(30_000),
  });
  const answer = body.ok ? checkSchema(MarkdownAnswerSchema, body.value) : undefined;
  if (!answer?.success) {
    throw new TypeError('Browser Run answered Markdown this service cannot read.');
  }
  return { value: answer.data.result.slice(0, maxLength) };
}

/** A PNG of the page at this width, its visible part or all of it, at most `maxBytes` long. */
export async function pageScreenshot(
  browser: BrowserRun,
  url: URL,
  options: { width: number; fullPage: boolean; maxBytes: number }
): Promise<Rendered<Uint8Array<ArrayBuffer>>> {
  const response = await quickAction(() =>
    browser.quickAction('screenshot', {
      ...page(url, options.width),
      screenshotOptions: { type: 'png', fullPage: options.fullPage },
    })
  );
  if (!(response instanceof Response)) {
    return response;
  }
  if (response.headers.get('content-type') !== 'image/png') {
    void response.body?.cancel().catch(() => {});
    throw new TypeError('Browser Run answered a screenshot that is not a PNG.');
  }
  const image = await readBodyBytes(response, { maxBytes: options.maxBytes });
  // A page whose image exceeds the limit is one this service will not answer.
  return image.ok ? { value: image.value } : { failure: 'PAGE_NOT_LOADED' };
}
