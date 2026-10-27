/**
 * The bounded body readers: a positive byte limit, refusal by declared length before reading, chunked bodies
 * cut off at the limit, deadlines before and during a read, failed streams and streams that refuse to be
 * cancelled, strict and lenient UTF-8, and a closed failure vocabulary that never carries body bytes.
 */
import { setTimeout as delay } from 'node:timers/promises';

import { expect, it, vi } from 'vite-plus/test';

import { httpBodyFailure, readBodyBytes, readBodyText } from '../../src/internal/body.ts';
import type { HttpBodyFailureReason } from '../../src/internal/body.ts';

const ORIGIN = 'https://records.example.test';
const encoder = new TextEncoder();

/** A refused read with its reason, as every reader answers it. */
function refused(reason: HttpBodyFailureReason) {
  return { ok: false, error: httpBodyFailure(reason) };
}

/** A body that sends one chunk per read, and records whether its reader cancelled it. */
function chunked(chunks: readonly string[]) {
  const cancel = vi.fn();
  let index = 0;
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) {
        controller.close();
      } else {
        controller.enqueue(encoder.encode(chunk));
      }
    },
    cancel,
  });
  return { body, cancel };
}

it('refuses a byte limit that is not a positive safe integer', async () => {
  for (const maxBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
    await expect(readBodyBytes(new Response('record'), { maxBytes }), String(maxBytes)).rejects.toThrow(
      new RangeError('Invalid body byte limit')
    );
  }
});

it('refuses by declared length before reading, cancelling the body without waiting for it', async () => {
  for (const [length, reason] of [
    ['abc', 'invalid_length'],
    ['-1', 'invalid_length'],
    ['1.5', 'invalid_length'],
    ['9', 'too_large'],
  ] as const) {
    const { body, cancel } = chunked(['private record']);
    const result = await readBodyBytes(new Response(body, { headers: { 'content-length': length } }), {
      maxBytes: 8,
    });
    expect(result, length).toStrictEqual(refused(reason));
    expect(cancel, length).toHaveBeenCalledOnce();
  }
  const { body } = chunked(['record']);
  expect(
    await readBodyBytes(new Response(body, { headers: { 'content-length': '6' } }), { maxBytes: 8 })
  ).toStrictEqual({ ok: true, value: encoder.encode('record') });
});

it('reads a request or a response without a body as no bytes', async () => {
  for (const source of [new Request(ORIGIN), new Response(null, { status: 204 })]) {
    expect(await readBodyBytes(source, { maxBytes: 1 })).toStrictEqual({
      ok: true,
      value: new Uint8Array(0),
    });
  }
});

it('reads a chunked body up to its limit, and cancels the rest once it exceeds it', async () => {
  expect(await readBodyBytes(new Response(chunked(['ab', 'cd', 'ef']).body), { maxBytes: 6 })).toStrictEqual({
    ok: true,
    value: encoder.encode('abcdef'),
  });
  const { body, cancel } = chunked(['ab', 'cd', 'ef', 'gh']);
  expect(await readBodyBytes(new Response(body), { maxBytes: 5 })).toStrictEqual(refused('too_large'));
  expect(cancel).toHaveBeenCalledOnce();
});

it('stops at a deadline that passed before the read or fires while it waits', async () => {
  const early = chunked(['record']);
  expect(
    await readBodyBytes(new Response(early.body), { maxBytes: 64, signal: AbortSignal.abort() })
  ).toStrictEqual(refused('aborted'));
  expect(early.cancel).toHaveBeenCalledOnce();

  // A sender that never answers: the deadline cancels the read it waits on.
  const deadline = new AbortController();
  const cancel = vi.fn();
  const stalled = new ReadableStream<Uint8Array<ArrayBuffer>>({ cancel });
  const reading = readBodyBytes(new Response(stalled), { maxBytes: 64, signal: deadline.signal });
  deadline.abort();
  expect(await reading).toStrictEqual(refused('aborted'));
  expect(cancel).toHaveBeenCalledOnce();
});

it('reports a failed stream as read_failed, and as aborted when the deadline fired with it', async () => {
  const reset = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      controller.error(new Error('connection reset'));
    },
  });
  expect(await readBodyBytes(new Response(reset), { maxBytes: 64 })).toStrictEqual(refused('read_failed'));
  const deadline = new AbortController();
  const racing = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      controller.error(new Error('connection reset'));
      deadline.abort();
    },
  });
  expect(await readBodyBytes(new Response(racing), { maxBytes: 64, signal: deadline.signal })).toStrictEqual(
    refused('aborted')
  );
});

it('never lets a body that refuses cancellation become an unhandled rejection', async () => {
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  try {
    /** A sender that keeps sending and fails to acknowledge cancellation. */
    const stubborn = () =>
      new ReadableStream<Uint8Array<ArrayBuffer>>({
        pull(controller) {
          controller.enqueue(new Uint8Array(8));
        },
        cancel() {
          throw new Error('remote gone');
        },
      });
    // Refused before reading, by its declared length, and while reading, beyond the limit.
    expect(
      await readBodyBytes(new Response(stubborn(), { headers: { 'content-length': '64' } }), { maxBytes: 8 })
    ).toStrictEqual(refused('too_large'));
    expect(await readBodyBytes(new Response(stubborn()), { maxBytes: 8 })).toStrictEqual(
      refused('too_large')
    );
    await delay(0);
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off('unhandledRejection', unhandled);
  }
});

it('decodes UTF-8 strictly by default and leniently on request', async () => {
  const invalid = () => new Response(new Uint8Array([0x7b, 0xc3, 0x28, 0x7d]));
  expect(await readBodyText(invalid(), { maxBytes: 64 })).toStrictEqual(refused('invalid_utf8'));
  expect(await readBodyText(invalid(), { maxBytes: 64, fatalUtf8: false })).toStrictEqual({
    ok: true,
    value: '{�(}',
  });
  // The limit counts bytes, not characters.
  expect(await readBodyText(new Response('héllo'), { maxBytes: 6 })).toStrictEqual({
    ok: true,
    value: 'héllo',
  });
  expect(await readBodyText(new Response('héllo'), { maxBytes: 5 })).toStrictEqual(refused('too_large'));
});

it("builds failures only from its closed vocabulary, never from a caller's text", () => {
  expect(httpBodyFailure('read_failed')).toStrictEqual({
    code: 'HTTP_BODY_INVALID',
    message: 'HTTP body could not be decoded',
    retryable: false,
    data: { reason: 'read_failed' },
  });
  expect(() => httpBodyFailure('connection reset by 10.0.0.7' as HttpBodyFailureReason)).toThrow(
    new TypeError('Invalid HTTP body reason')
  );
});
