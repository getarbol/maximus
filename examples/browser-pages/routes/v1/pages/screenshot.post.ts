import { AttachmentOutputSchema, defineHandler, t } from '@arbol-ai/maximus';

import { pageScreenshot } from '../../../src/browser.ts';
import { allowedUrl } from '../../../src/hosts.ts';

/** The largest image a screenshot answers, in bytes. */
const MAX_IMAGE = 8 * 1024 * 1024;

/** POST /api/v1/pages/screenshot: a PNG of a page as Chrome renders it, its visible part or all of it. */
export default defineHandler(
  async ({ input, env, fail }) => {
    const url = allowedUrl(input.url);
    if (!url) {
      return fail('HOST_NOT_ALLOWED');
    }
    const captured = await pageScreenshot(env.BROWSER, url, {
      width: input.width ?? 1280,
      fullPage: input.fullPage ?? false,
      maxBytes: MAX_IMAGE,
    });
    return 'value' in captured
      ? {
          body: captured.value,
          contentType: 'image/png',
          filename: `${url.hostname}.png`,
          byteLength: captured.value.byteLength,
        }
      : fail(captured.failure);
  },
  {
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
    maxOutputBytes: MAX_IMAGE,
  }
);
