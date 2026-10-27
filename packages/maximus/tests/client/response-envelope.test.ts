/**
 * The client's reader of operation envelopes: the exact shape of a success or a refusal, a status that
 * agrees with it, a canonical request id, and a bounded read that keeps refusals small and never turns
 * a malformed success into a refusal.
 */
import { expect, it } from 'vite-plus/test';

import { readOperationEnvelope, responseEnvelope } from '../../src/client/response-envelope.ts';

const REQUEST_ID = '0b5e1c9a-3f2d-4e8b-9c1a-7d6e5f4a3b2c';
const metadata = { requestId: REQUEST_ID };
const failure = { code: 'RECORD_LOCKED', message: 'The record is locked.', retryable: true, data: {} };
const success = { success: true, data: { recordId: 'r1' }, error: null, metadata };
const refusal = { success: false, data: null, error: failure, metadata };
const INTERNAL = {
  code: 'INTERNAL_ERROR',
  message: 'The service could not complete the operation.',
  retryable: false,
  data: {},
};

/** Reading options with a live signal. */
function reading(maxBytes: number, dataMode: boolean) {
  return { signal: new AbortController().signal, maxBytes, dataMode };
}

it.each([200, 201, 202, 299])('accepts a success envelope answered with %s', (status) => {
  expect(responseEnvelope(success, status)).toStrictEqual(success);
});

it.each([199, 302, 404, 500])('refuses a success envelope answered with %s', (status) => {
  expect(() => responseEnvelope(success, status)).toThrow(new Error(`Invalid service response (${status}).`));
});

it.each([400, 409, 599])('accepts a refusal envelope answered with %s', (status) => {
  expect(responseEnvelope(refusal, status)).toStrictEqual(refusal);
});

it.each([200, 302, 399, 600])('refuses a refusal envelope answered with %s', (status) => {
  expect(() => responseEnvelope(refusal, status)).toThrow(new Error(`Invalid service response (${status}).`));
});

it.each(['8f3b2a1c4d5e6f70', '8f3b2a1c4d5e6f70-IAD'])('accepts the edge ray id %s as a request id', (id) => {
  expect(responseEnvelope({ ...success, metadata: { requestId: id } }, 200).metadata).toStrictEqual({
    requestId: id,
  });
});

it.each([
  ['nothing', null],
  ['a list', [success]],
  ['text', 'ok'],
  ['an extra field', { ...success, extra: true }],
  ['no error field', { success: true, data: {}, metadata }],
  ['data under another name', { success: true, value: {}, error: null, metadata }],
  ['metadata that is not an object', { ...success, metadata: REQUEST_ID }],
  ['metadata with an extra field', { ...success, metadata: { ...metadata, traceId: 'trace-1' } }],
  ['a request id that is not one', { ...success, metadata: { requestId: 'request-1' } }],
  ['a success flag that is not a boolean', { ...success, success: 'true' }],
  ['a success that carries an error', { ...success, error: failure }],
  ['a refusal that carries data', { ...refusal, data: {} }],
])('refuses an envelope with %s, whatever its status', (_name, value) => {
  for (const status of [200, 409]) {
    expect(() => responseEnvelope(value, status)).toThrow(new Error(`Invalid service response (${status}).`));
  }
});

it.each([
  ['no failure', null],
  ['a missing field', { code: 'RECORD_LOCKED', message: 'The record is locked.', retryable: true }],
  ['an extra field', { ...failure, status: 409 }],
  ['an empty code', { ...failure, code: '' }],
  ['a code of 129 characters', { ...failure, code: 'X'.repeat(129) }],
  ['a code with a control character', { ...failure, code: 'RECORD\nLOCKED' }],
  ['a code that is not text', { ...failure, code: 409 }],
  ['a message that is not text', { ...failure, message: null }],
  ['retryable that is not a boolean', { ...failure, retryable: 'yes' }],
  ['data that is a list', { ...failure, data: [] }],
  ['null data', { ...failure, data: null }],
])('refuses a refusal whose failure has %s', (_name, error) => {
  expect(() => responseEnvelope({ ...refusal, error }, 409)).toThrow(
    new Error('Invalid service response (409).')
  );
});

it('accepts a failure code of 128 printable characters', () => {
  const error = { ...failure, code: 'X'.repeat(128) };
  expect(responseEnvelope({ ...refusal, error }, 409)).toStrictEqual({ ...refusal, error });
});

it('reads a success within its byte limit', async () => {
  await expect(readOperationEnvelope(Response.json(success), reading(1024, false))).resolves.toStrictEqual(
    success
  );
});

it('refuses a success above its byte limit in either mode', async () => {
  for (const dataMode of [false, true]) {
    await expect(readOperationEnvelope(Response.json(success), reading(64, dataMode))).rejects.toThrow(
      new Error('Invalid service response (200).')
    );
  }
});

it('reads a refusal body of at most 16 KiB, even when the success limit is larger', async () => {
  const padded = () =>
    Response.json(
      { ...refusal, error: { ...failure, message: 'x'.repeat(16 * 1024) } },
      { status: 409, headers: { 'x-request-id': REQUEST_ID } }
    );
  await expect(readOperationEnvelope(padded(), reading(1024 * 1024, false))).rejects.toThrow(
    new Error('Invalid service response (409).')
  );
  await expect(readOperationEnvelope(padded(), reading(1024 * 1024, true))).resolves.toStrictEqual({
    success: false,
    data: null,
    error: INTERNAL,
    metadata: { requestId: REQUEST_ID },
  });
});

it('holds a refusal to the success limit when that limit is smaller than 16 KiB', async () => {
  const answer = () => Response.json(refusal, { status: 409 });
  await expect(readOperationEnvelope(answer(), reading(1024, false))).resolves.toStrictEqual(refusal);
  await expect(readOperationEnvelope(answer(), reading(64, false))).rejects.toThrow(
    new Error('Invalid service response (409).')
  );
});

it.each([
  ['a request id', REQUEST_ID, REQUEST_ID],
  ['an edge ray id', '8f3b2a1c4d5e6f70-IAD', '8f3b2a1c4d5e6f70-IAD'],
  ['an id that is not one', 'request-1', ''],
  ['no id', null, ''],
])(
  'gives an unreadable data-mode refusal the canonical failure and, for %s in its headers, %j',
  async (_name, header, requestId) => {
    const answer = new Response('Service unavailable', {
      status: 503,
      headers: header === null ? {} : { 'x-request-id': header },
    });
    await expect(readOperationEnvelope(answer, reading(1024, true))).resolves.toStrictEqual({
      success: false,
      data: null,
      error: INTERNAL,
      metadata: { requestId },
    });
  }
);

it('never reads an empty or malformed success as a refusal, even in data mode', async () => {
  await expect(
    readOperationEnvelope(new Response(null, { status: 204 }), reading(1024, true))
  ).rejects.toThrow(new Error('Invalid service response (204).'));
  const truncated = new Response('{"success":', { headers: { 'content-type': 'application/json' } });
  await expect(readOperationEnvelope(truncated, reading(1024, true))).rejects.toThrow(
    new Error('Invalid service response (200).')
  );
});

it('rejects with the abort reason instead of reading the answer of a cancelled call', async () => {
  const reason = new Error('The caller left.');
  const answers: [Response, boolean][] = [
    [Response.json(success), false],
    [new Response('Service unavailable', { status: 503 }), true],
  ];
  for (const [answer, dataMode] of answers) {
    await expect(
      readOperationEnvelope(answer, { signal: AbortSignal.abort(reason), maxBytes: 1024, dataMode })
    ).rejects.toBe(reason);
  }
});
