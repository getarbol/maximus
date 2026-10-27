/**
 * The client's attachment reader: a declared content-length within the client's limit, and a body that
 * streams through held to that exact length.
 */
import { expect, it, vi } from 'vite-plus/test';

import { boundedAttachment } from '../../src/client/attachment-response.ts';

const REQUEST_ID = '0b5e1c9a-3f2d-4e8b-9c1a-7d6e5f4a3b2c';
const LENGTH_REFUSAL = new Error('Invalid attachment length.');

it('passes an attachment through with its status, headers and exact bytes', async () => {
  const response = new Response('hello', {
    status: 201,
    statusText: 'Created',
    headers: { 'content-length': '5', 'content-type': 'text/plain', 'x-request-id': REQUEST_ID },
  });
  const bounded = boundedAttachment(response, 5);
  expect(bounded.status).toBe(201);
  expect(bounded.statusText).toBe('Created');
  expect(Object.fromEntries(bounded.headers)).toStrictEqual({
    'content-length': '5',
    'content-type': 'text/plain',
    'x-request-id': REQUEST_ID,
  });
  expect(await bounded.text()).toBe('hello');
});

it.each([
  ['no declared length', new Headers()],
  ['an empty length', new Headers({ 'content-length': '' })],
  ['a negative length', new Headers({ 'content-length': '-1' })],
  ['a fractional length', new Headers({ 'content-length': '1.5' })],
  ['a length with a unit', new Headers({ 'content-length': '5 bytes' })],
  [
    'two lengths',
    new Headers([
      ['content-length', '5'],
      ['content-length', '5'],
    ]),
  ],
  ['a length beyond the safe integers', new Headers({ 'content-length': '9007199254740993' })],
  ['a length above the limit', new Headers({ 'content-length': '6' })],
])('refuses an attachment with %s', (_name, headers) => {
  expect(() => boundedAttachment(new Response('hello', { headers }), 5)).toThrow(LENGTH_REFUSAL);
});

it('cancels the body of an attachment whose length it refuses, which it never reads', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  expect(() => boundedAttachment(new Response(body), 5)).toThrow(LENGTH_REFUSAL);
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
});

it('accepts an empty attachment that has no body', () => {
  const response = new Response(null, { headers: { 'content-length': '0' } });
  expect(boundedAttachment(response, 5)).toBe(response);
});

it('refuses a declared length without a body', () => {
  expect(() => boundedAttachment(new Response(null, { headers: { 'content-length': '3' } }), 5)).toThrow(
    new Error('Missing attachment body.')
  );
});

it('errors a body that carries more bytes than its declared length', async () => {
  const bounded = boundedAttachment(new Response('hello world', { headers: { 'content-length': '5' } }), 16);
  await expect(bounded.arrayBuffer()).rejects.toThrow(
    new TypeError('A byte stream exceeds its declared length.')
  );
});

it('errors a body that ends before its declared length', async () => {
  const bounded = boundedAttachment(new Response('hello', { headers: { 'content-length': '8' } }), 16);
  await expect(bounded.text()).rejects.toThrow(
    new TypeError('A byte stream ended before its declared length.')
  );
});

it('streams bytes as they arrive instead of buffering the attachment first', async () => {
  // The source sends three of its five bytes and then waits.
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('hel'));
    },
  });
  const bounded = boundedAttachment(new Response(source, { headers: { 'content-length': '5' } }), 5);
  const reader = bounded.body?.getReader();
  expect(new TextDecoder().decode((await reader?.read())?.value)).toBe('hel');
  await reader?.cancel();
});
