/**
 * Span annotation: the active Workers span receives the service, the operation and a valid request id,
 * and a missing or failing tracing API never reaches the caller.
 */
import { afterEach, expect, it } from 'vite-plus/test';

import { tracing } from '../../src/vite/cloudflare-workers.ts';
import { annotateInvocation } from '../../src/workers/internal/worker-tracing.ts';

const requestId = '00000000-0000-4000-8000-000000000001';
const installed = tracing.getActiveSpan;
afterEach(() => {
  if (installed) {
    tracing.getActiveSpan = installed;
  } else {
    delete tracing.getActiveSpan;
  }
});

/** Installs an active span and returns the attributes each annotation sets on it. */
function activeSpan(): Record<string, unknown>[] {
  const annotations: Record<string, unknown>[] = [];
  tracing.getActiveSpan = () => ({
    setAttributes: (attributes) => {
      annotations.push(attributes);
    },
  });
  return annotations;
}

it('sets the service, the operation and the request id on the active span', () => {
  const annotations = activeSpan();
  annotateInvocation('records', 'readRecord', requestId);
  annotateInvocation('records', 'readRecord', '0123456789abcdef-IAD');
  expect(annotations).toEqual([
    { 'service.name': 'records', 'operation.name': 'readRecord', 'request.id': requestId },
    { 'service.name': 'records', 'operation.name': 'readRecord', 'request.id': '0123456789abcdef-IAD' },
  ]);
});

it('leaves out a request id that is neither a UUID nor a Cloudflare ray id', () => {
  const annotations = activeSpan();
  for (const forged of ['Bearer a.b.c', 'org_1234567890abcdef', `${requestId}\nrequest.id=forged`, '']) {
    annotateInvocation('records', 'readRecord', forged);
  }
  expect(annotations).toHaveLength(4);
  for (const attributes of annotations) {
    expect(attributes).toEqual({ 'service.name': 'records', 'operation.name': 'readRecord' });
  }
});

it('does nothing when the runtime has no span API or no active span', () => {
  expect(() => annotateInvocation('records', 'readRecord', requestId)).not.toThrow();
  tracing.getActiveSpan = () => undefined;
  expect(() => annotateInvocation('records', 'readRecord', requestId)).not.toThrow();
});

it('never lets a failing span API reach the caller', () => {
  tracing.getActiveSpan = () => {
    throw new Error('tracing unavailable');
  };
  expect(() => annotateInvocation('records', 'readRecord', requestId)).not.toThrow();
  tracing.getActiveSpan = () => ({
    setAttributes: () => {
      throw new TypeError('span already ended');
    },
  });
  expect(() => annotateInvocation('records', 'readRecord', requestId)).not.toThrow();
});
