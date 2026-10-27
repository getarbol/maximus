/**
 * Bounded JSON over Web bodies: media types read without their parameters, structured `+json` types
 * accepted only where allowed, bodies of another type cancelled unread, empty 204 and 205 answers, a passed
 * deadline, and a Retry-After hint bounded to a safe wait.
 */
import { expect, it, vi } from 'vite-plus/test';

import { httpBodyFailure } from '../../src/internal/body.ts';
import type { HttpBodyFailureReason } from '../../src/internal/body.ts';
import {
  isJsonMediaType,
  mediaType,
  readJsonBody,
  readJsonResponse,
  retryAfterSeconds,
} from '../../src/internal/json.ts';

/** A refused read with its reason, as every reader answers it. */
function refused(reason: HttpBodyFailureReason) {
  return { ok: false, error: httpBodyFailure(reason) };
}
/** A body of the media type given. */
function typed(body: BodyInit, contentType: string) {
  return new Response(body, { headers: { 'content-type': contentType } });
}
/** A deadline that has not passed. */
const pending = () => new AbortController().signal;

it('reads a media type without its parameters or case, and recognizes structured JSON types', () => {
  expect(mediaType('Application/JSON; charset=utf-8')).toBe('application/json');
  expect(mediaType(null)).toBeUndefined();
  for (const type of ['application/json', 'application/problem+json', 'Application/Vnd.Records+JSON; v=2']) {
    expect(isJsonMediaType(type), type).toBe(true);
  }
  for (const type of [
    null,
    '',
    'text/json',
    'application/jsonp',
    'application/json-seq',
    'text/plain+json',
  ]) {
    expect(isJsonMediaType(type), String(type)).toBe(false);
  }
});

it('reads a JSON body only under its media type, and within its limit', async () => {
  expect(
    await readJsonBody(typed('{"recordId":"r1"}', 'application/json; charset=utf-8'), { maxBytes: 64 })
  ).toStrictEqual({ ok: true, value: { recordId: 'r1' } });
  // A structured type is JSON only where the reader allows it.
  const problem = () => typed('{"code":"RECORD_LOCKED"}', 'application/problem+json');
  expect(await readJsonBody(problem(), { maxBytes: 64 })).toStrictEqual(refused('unexpected_content_type'));
  expect(await readJsonBody(problem(), { maxBytes: 64, allowJsonSuffix: true })).toStrictEqual({
    ok: true,
    value: { code: 'RECORD_LOCKED' },
  });
  expect(await readJsonBody(new Response(new TextEncoder().encode('{}')), { maxBytes: 64 })).toStrictEqual(
    refused('unexpected_content_type')
  );
  expect(await readJsonBody(typed('{"recordId":', 'application/json'), { maxBytes: 64 })).toStrictEqual(
    refused('invalid_json')
  );
  expect(await readJsonBody(typed('{"recordId":"r1"}', 'application/json'), { maxBytes: 8 })).toStrictEqual(
    refused('too_large')
  );
});

it('refuses and cancels a body of another media type, even when cancellation fails', async () => {
  for (const cancel of [
    vi.fn(),
    vi.fn(() => {
      throw new Error('remote gone');
    }),
  ]) {
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({ cancel });
    const html = new Response(body, { headers: { 'content-type': 'text/html' } });
    expect(await readJsonBody(html, { maxBytes: 64 })).toStrictEqual(refused('unexpected_content_type'));
    expect(cancel).toHaveBeenCalledOnce();
  }
});

it('answers an empty 204 or 205 as null, a problem document as JSON, and nothing after its deadline', async () => {
  for (const status of [204, 205]) {
    expect(
      await readJsonResponse(new Response(null, { status }), { maxBytes: 64, signal: pending() })
    ).toStrictEqual({ ok: true, value: null });
  }
  const locked = new Response('{"code":"RECORD_LOCKED"}', {
    status: 409,
    headers: { 'content-type': 'application/problem+json' },
  });
  expect(await readJsonResponse(locked, { maxBytes: 64, signal: pending() })).toStrictEqual({
    ok: true,
    value: { code: 'RECORD_LOCKED' },
  });
  // The body of a response that arrived too late is cancelled, even when the sender fails to acknowledge it.
  const cancel = vi.fn(() => {
    throw new Error('remote gone');
  });
  const late = typed(new ReadableStream<Uint8Array<ArrayBuffer>>({ cancel }), 'application/json');
  expect(await readJsonResponse(late, { maxBytes: 64, signal: AbortSignal.abort() })).toStrictEqual(
    refused('aborted')
  );
  expect(cancel).toHaveBeenCalledOnce();
});

it('bounds a Retry-After hint given in seconds or as an HTTP date', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  expect(retryAfterSeconds('120', now)).toBe(120);
  expect(retryAfterSeconds(' 30 ', now)).toBe(30);
  expect(retryAfterSeconds('0', now)).toBe(0);
  // At most an hour by default, or the caller's own bound.
  expect(retryAfterSeconds('86400', now)).toBe(3600);
  expect(retryAfterSeconds('120', now, 60)).toBe(60);
  expect(retryAfterSeconds('Tue, 27 Oct 2026 12:01:30 GMT', now)).toBe(90);
  // A partial second waits the whole second; a date already past waits nothing.
  expect(retryAfterSeconds('Tue, 27 Oct 2026 12:00:01 GMT', now + 500)).toBe(1);
  expect(retryAfterSeconds('Mon, 26 Oct 2026 12:00:00 GMT', now)).toBe(0);
});

it('gives no Retry-After hint for a missing or unreadable value, or an invalid clock or bound', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  for (const value of [null, '', 'soon']) {
    expect(retryAfterSeconds(value, now), String(value)).toBeUndefined();
  }
  for (const clock of [Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(retryAfterSeconds('120', clock)).toBeUndefined();
  }
  for (const maximum of [-1, 1.5, Number.NaN]) {
    expect(retryAfterSeconds('120', now, maximum), String(maximum)).toBeUndefined();
  }
});
