/**
 * Pages through Browser Run's quick actions: Chrome, on Cloudflare's network, opens the page with every
 * request it makes held to the allowed hosts, and answers Markdown or a PNG. Its answers are read within
 * limits and checked before they are used.
 */
import { err, ok, readBodyBytes, readJsonResponse, reportUnexpected, t } from '@arbol-ai/maximus';
import type { Result } from '@arbol-ai/maximus';
import { checkSchema } from '@arbol-ai/maximus/schemas';

import { ALLOWED_REQUEST_PATTERNS } from './hosts.ts';

/** Why Browser Run answered no page: the page did not load, or Browser Run is busy or unavailable. */
export type BrowserFailure = 'PAGE_NOT_LOADED' | 'UPSTREAM_UNAVAILABLE';

/** The viewport's width when a call names none, in CSS pixels. */
const DEFAULT_WIDTH_PIXELS = 1280;
/** The viewport's height, in CSS pixels. */
const VIEWPORT_HEIGHT_PIXELS = 800;
/** How long Chrome waits for a page to load. */
const PAGE_LOAD_TIMEOUT_MS = 15_000;
/** The largest answer of the markdown action the service reads, in bytes. */
const MAX_MARKDOWN_ANSWER_BYTES = 2 * 1024 * 1024;
/** How long the service waits for the markdown action's answer. */
const MARKDOWN_ANSWER_TIMEOUT_MS = 30_000;

/** What every quick action is given: the page, its viewport, its load deadline and the requests allowed. */
function quickActionOptions(url: URL, width: number): BrowserRunBaseOptions & { url: string } {
  return {
    url: url.href,
    viewport: { width, height: VIEWPORT_HEIGHT_PIXELS },
    gotoOptions: { waitUntil: 'load', timeout: PAGE_LOAD_TIMEOUT_MS },
    allowRequestPattern: [...ALLOWED_REQUEST_PATTERNS],
  };
}

/** Whether a status says Browser Run is over the account's limits (429) or unavailable (5xx). */
function isUnavailable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Runs a quick action, and answers its response when it succeeded or the failure it reports. Browser Run
 * refuses a page that does not load with 422 and a call over the account's limits with 429; a request it
 * finds malformed is this service's error, and throws.
 */
async function runQuickAction(runAction: () => Promise<Response>): Promise<Result<Response, BrowserFailure>> {
  let response: Response;
  try {
    response = await runAction();
  } catch (error) {
    reportUnexpected(error, 'browser');
    return err('UPSTREAM_UNAVAILABLE');
  }
  if (response.ok) {
    return ok(response);
  }
  // Nothing reads a refusal's body; cancelling it frees the connection.
  void response.body?.cancel().catch(() => {});
  if (response.status === 422) {
    return err('PAGE_NOT_LOADED');
  }
  if (isUnavailable(response.status)) {
    return err('UPSTREAM_UNAVAILABLE');
  }
  throw new TypeError(`Browser Run refused the request with ${response.status}.`);
}

/** What the markdown action answers. */
const MarkdownAnswerSchema = t.Object({ success: t.Literal(true), result: t.String() });

/** The page as Markdown, at most `maxCharacters` of it. */
export async function readPageAsMarkdown(
  browser: BrowserRun,
  url: URL,
  maxCharacters: number
): Promise<Result<string, BrowserFailure>> {
  const answer = await runQuickAction(() =>
    browser.quickAction('markdown', quickActionOptions(url, DEFAULT_WIDTH_PIXELS))
  );
  if (!answer.ok) {
    return answer;
  }
  const body = await readJsonResponse(answer.value, {
    maxBytes: MAX_MARKDOWN_ANSWER_BYTES,
    signal: AbortSignal.timeout(MARKDOWN_ANSWER_TIMEOUT_MS),
  });
  if (!body.ok) {
    throw new TypeError('Browser Run answered a body this service cannot read.');
  }
  const markdownAnswer = checkSchema(MarkdownAnswerSchema, body.value);
  if (!markdownAnswer.success) {
    throw new TypeError('Browser Run answered Markdown this service cannot read.');
  }
  return ok(markdownAnswer.data.result.slice(0, maxCharacters));
}

/** How to capture a page: the viewport's width, the whole page or its visible part, and the largest image. */
export interface ScreenshotOptions {
  /** The viewport's width, in CSS pixels; 1280 when left out. */
  width?: number;
  /** Whether to capture the whole page rather than its visible part; the visible part when left out. */
  fullPage?: boolean;
  /** The largest image the service answers, in bytes. */
  maxBytes: number;
}

/** A PNG of the page, its visible part or all of it, at most `options.maxBytes` long. */
export async function capturePageAsPng(
  browser: BrowserRun,
  url: URL,
  options: ScreenshotOptions
): Promise<Result<Uint8Array<ArrayBuffer>, BrowserFailure>> {
  const { width = DEFAULT_WIDTH_PIXELS, fullPage = false, maxBytes } = options;
  const answer = await runQuickAction(() =>
    browser.quickAction('screenshot', {
      ...quickActionOptions(url, width),
      screenshotOptions: { type: 'png', fullPage },
    })
  );
  if (!answer.ok) {
    return answer;
  }
  const response = answer.value;
  if (response.headers.get('content-type') !== 'image/png') {
    void response.body?.cancel().catch(() => {});
    throw new TypeError('Browser Run answered a screenshot that is not a PNG.');
  }
  const image = await readBodyBytes(response, { maxBytes });
  if (!image.ok) {
    // A page whose image exceeds the limit is one this service will not answer.
    return err('PAGE_NOT_LOADED');
  }
  return ok(image.value);
}
