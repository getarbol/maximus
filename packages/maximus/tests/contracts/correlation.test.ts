/**
 * Request correlation: request ids are canonical UUIDs or Cloudflare ray ids; a well-formed edge ray is
 * adopted and anything else replaced by a freshly minted UUID; a W3C `traceparent` of version 00 is parsed
 * strictly, refusing all-zero ids, other versions, uppercase and trailing data; and durable work keeps only a
 * valid request id and a traceparent that parses.
 */
import { expect, it } from 'vite-plus/test';

import { createRequestId, durableCorrelation, isRequestId, parseTraceParent } from '../../src/diagnostics.ts';

const UUID = '0190c6d4-8f3e-7a6b-9c1d-2e3f4a5b6c7d';
const RAY = '8f3e7a6b9c1d2e3f';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = '00f067aa0ba902b7';
const TRACEPARENT = `00-${TRACE}-${PARENT}-01`;
/** A version 4 UUID as `crypto.randomUUID()` mints it. */
const MINTED = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

it('recognizes only canonical UUIDs and Cloudflare ray ids as request ids', () => {
  for (const id of [UUID, UUID.toUpperCase(), RAY, `${RAY}-IAD`]) {
    expect(isRequestId(id), id).toBe(true);
  }
  const forged = [
    `${UUID}\nlevel=admin`,
    `{${UUID}}`,
    UUID.replaceAll('-', ''),
    `${RAY}0`,
    RAY.toUpperCase(),
    `${RAY}-iad`,
    `${RAY}-IADX`,
    'req-1',
    '',
    42,
    null,
    undefined,
    { id: UUID },
  ];
  for (const value of forged) {
    expect(isRequestId(value), JSON.stringify(value)).toBe(false);
  }
});

it('adopts a well-formed edge ray and mints a fresh UUID for anything a caller could have forged', () => {
  expect(createRequestId(RAY)).toBe(RAY);
  expect(createRequestId(`${RAY}-IAD`)).toBe(`${RAY}-IAD`);
  const forged = [undefined, null, '', 'attacker-chosen', `${RAY}\nlevel=admin`, 'x'.repeat(10_000)];
  const minted = forged.map((value) => createRequestId(value));
  for (const id of minted) {
    expect(id).toMatch(MINTED);
  }
  expect(new Set(minted).size).toBe(forged.length);
});

it('parses a W3C traceparent of version 00, reading only the sampled bit of its flags', () => {
  expect(parseTraceParent(TRACEPARENT)).toEqual({ traceId: TRACE, parentSpanId: PARENT, sampled: true });
  expect(parseTraceParent(`00-${TRACE}-${PARENT}-00`)).toEqual({
    traceId: TRACE,
    parentSpanId: PARENT,
    sampled: false,
  });
  expect(parseTraceParent(`00-${TRACE}-${PARENT}-03`)?.sampled).toBe(true);
  expect(parseTraceParent(`00-${TRACE}-${PARENT}-02`)?.sampled).toBe(false);
});

it('refuses a traceparent that is absent, of another version, all zeros, uppercase or with anything around it', () => {
  const refused = [
    undefined,
    null,
    '',
    `01-${TRACE}-${PARENT}-01`,
    `ff-${TRACE}-${PARENT}-01`,
    `00-${'0'.repeat(32)}-${PARENT}-01`,
    `00-${TRACE}-${'0'.repeat(16)}-01`,
    `00-${TRACE.toUpperCase()}-${PARENT}-01`,
    `00-${TRACE.slice(1)}-${PARENT}-01`,
    `00-${TRACE}-${PARENT}-1`,
    `00-${TRACE}-${PARENT}-01-extra`,
    ` ${TRACEPARENT}`,
    `${TRACEPARENT}\n`,
    `00_${TRACE}_${PARENT}_01`,
  ];
  for (const header of refused) {
    expect(parseTraceParent(header), JSON.stringify(header)).toBeUndefined();
  }
});

it('persists a valid request id, with the originating traceparent only when it parses', () => {
  expect(durableCorrelation(UUID, TRACEPARENT)).toEqual({ requestId: UUID, originTraceParent: TRACEPARENT });
  expect(durableCorrelation(RAY)).toEqual({ requestId: RAY });
  // Nothing that does not parse is persisted beside the id, such as baggage or an all-zero trace.
  for (const origin of ['baggage=tenant-secret', `00-${'0'.repeat(32)}-${PARENT}-01`]) {
    expect(durableCorrelation(UUID, origin), origin).toEqual({ requestId: UUID });
  }
  for (const requestId of ['', 'req-1', `${UUID}\n`]) {
    expect(() => durableCorrelation(requestId), JSON.stringify(requestId)).toThrow(
      new TypeError('Invalid correlation id')
    );
  }
});
