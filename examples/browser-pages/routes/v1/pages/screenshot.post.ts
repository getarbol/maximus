import { AttachmentOutputSchema, defineHandler, t } from '@arbol-ai/maximus';

import { capturePageAsPng } from '#src/browser.ts';
import { parseAllowedUrl } from '#src/hosts.ts';

/** The largest image a screenshot answers, in bytes. */
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

/** POST /api/v1/pages/screenshot: a PNG of a page as Chrome renders it, its visible part or all of it. */
export default defineHandler(
  async ({ input, env, fail }) => {
    const url = parseAllowedUrl(input.url);
    if (!url) {
      return fail('HOST_NOT_ALLOWED');
    }
    const captured = await capturePageAsPng(env.BROWSER, url, {
      width: input.width,
      fullPage: input.fullPage,
      maxBytes: MAX_SCREENSHOT_BYTES,
    });
    if (!captured.ok) {
      return fail(captured.error);
    }
    const image = captured.value;
    return {
      body: image,
      contentType: 'image/png',
      filename: `${url.hostname}.png`,
      byteLength: image.byteLength,
    };
  },
  {
    // A call captures one page, which the path alone would name screenshotPages.
    operationId: 'screenshotPage',
    title: 'Screenshot a page',
    description: 'Capture a PNG of a public web page at an allowed host, as Chrome renders it.',
    effect: 'read',
    input: {
      url: t.String({ maxLength: 2048, description: 'An https address at an allowed host.' }),
      width: t.Optional(t.Integer({ minimum: 320, maximum: 1920 })),
      fullPage: t.Optional(t.Boolean()),
    },
    output: AttachmentOutputSchema,
    failures: ['HOST_NOT_ALLOWED', 'PAGE_NOT_LOADED'],
    http: { response: 'attachment' },
    maxOutputBytes: MAX_SCREENSHOT_BYTES,
  }
);
