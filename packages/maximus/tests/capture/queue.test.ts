/**
 * The queue sink: one JSON message per record, sent once for the queue's consumer to retry and dead-letter, a
 * payload too large for a message written to the bucket by reference, nothing recorded without the binding,
 * and the records an application's calls send through it.
 */
import { expect, it } from 'vite-plus/test';

import { queue } from '../../src/capture/index.ts';
import type { CaptureRecord } from '../../src/capture/index.ts';
import { createHttpHandler, defineErrors, maximus, ok, t } from '../../src/index.ts';

/** What a queue's producer binding was sent, standing in for it. */
function producer(refuse = false) {
  const sent: { message: unknown; options: unknown }[] = [];
  return {
    sent,
    send: async (message: unknown, options: unknown) => {
      sent.push({ message, options });
      if (refuse) {
        throw new Error('Queue unavailable');
      }
    },
  };
}
/** What an R2 binding was asked to keep, standing in for it. */
function bucket() {
  const kept = new Map<string, string | Uint8Array>();
  return { kept, put: async (key: string, value: string | Uint8Array) => kept.set(key, value) };
}
/** A record of one successful call, with a payload of about `payloadBytes` bytes. */
function record(payloadBytes = 10): CaptureRecord {
  return {
    id: '0192f0a0-0000-7000-8000-000000000001',
    service: 'notes',
    operation: 'createNote',
    organizationId: 'org_1234567890abcdef',
    actorId: 'user_1',
    actorKind: 'user',
    requestId: '00000000-0000-4000-8000-000000000001',
    traceId: null,
    surface: 'http',
    occurredAt: 1_762_473_600_000,
    durationMicros: 1200,
    outcome: 'success',
    errorCode: null,
    stage: 'execution',
    version: '1',
    effect: 'write',
    scopes: ['notes:notes:write'],
    visibility: 'public',
    httpMethod: 'POST',
    httpPath: '/v1/notes',
    mcpTool: null,
    rpcCaller: null,
    clientId: 'client',
    clientClass: 'human',
    grantedScopes: ['notes:notes:write'],
    userAgent: null,
    tokenSha256: null,
    dimensions: {},
    startedAt: 1_762_473_599_998,
    admissionMicros: 300,
    input: { text: 'x'.repeat(payloadBytes) },
    output: { noteId: 'n1' },
    failureData: null,
    payloadRef: null,
  };
}

it('refuses a queue it cannot name, and records nothing while the env has no such binding', () => {
  expect(() => queue({ binding: '' })).toThrow(new TypeError('queue() takes the name of a queue binding.'));
  const sink = queue({ binding: 'CAPTURE' });
  expect(sink.available?.({})).toBe(false);
  expect(sink.available?.({ CAPTURE: {} })).toBe(false);
  expect(sink.available?.({ CAPTURE: producer() })).toBe(true);
});

it('sends each record once, as one JSON message, and fails a delivery the queue refuses without retrying', async () => {
  const accepting = producer();
  await queue({ binding: 'CAPTURE' }).send(record(), { CAPTURE: accepting });
  expect(accepting.sent).toStrictEqual([{ message: record(), options: { contentType: 'json' } }]);
  const refusing = producer(true);
  await expect(queue({ binding: 'CAPTURE' }).send(record(), { CAPTURE: refusing })).rejects.toThrow(
    'Queue unavailable'
  );
  // The queue's consumer retries what it fails; a send the queue refuses is not repeated here.
  expect(refusing.sent).toHaveLength(1);
});

it('writes a payload too large for one message to the bucket, and fails it without one', async () => {
  const queued = producer();
  const blobs = bucket();
  await queue({ binding: 'CAPTURE', blobs: 'BLOBS' }).send(record(120_000), {
    CAPTURE: queued,
    BLOBS: blobs,
  });
  const key = 'payloads/org_1234567890abcdef/0192f0a0-0000-7000-8000-000000000001.json';
  expect([...blobs.kept.keys()]).toStrictEqual([key]);
  const message = queued.sent[0]?.message as CaptureRecord;
  expect(message).toMatchObject({ input: null, output: null, failureData: null });
  expect(message.payloadRef).toMatchObject({ $ref: key, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  // What a message holds: 128 KB.
  expect(new TextEncoder().encode(JSON.stringify(message)).byteLength).toBeLessThan(128_000);
  // A payload just under the limit stays in the message.
  const small = producer();
  await queue({ binding: 'CAPTURE', blobs: 'BLOBS' }).send(record(90_000), {
    CAPTURE: small,
    BLOBS: bucket(),
  });
  expect(small.sent[0]?.message).toStrictEqual(record(90_000));
  const unbucketed = producer();
  await expect(queue({ binding: 'CAPTURE' }).send(record(120_000), { CAPTURE: unbucketed })).rejects.toThrow(
    RangeError
  );
  expect(unbucketed.sent).toHaveLength(0);
});

it("sends the record of an application's call to the queue, after the response", async () => {
  const app = maximus<{ CAPTURE: ReturnType<typeof producer> }>({
    name: 'notes',
    namespace: 'notes',
    title: 'Notes',
    version: '1',
    origin: 'https://notes.example.test',
    tokens: { issuer: 'https://issuer.example.test/', audience: 'https://notes.example.test' },
    errors: defineErrors({}),
    rpc: { callers: [] },
    telemetry: { enabled: false },
    // A Worker composed by hand passes what capture.ts would declare.
    capture: { sink: queue({ binding: 'CAPTURE' }), payloads: 'all' },
  })
    .operation(
      'createNote',
      {
        scope: 'notes:notes:write',
        title: 'Create a note',
        description: 'Create a note.',
        effect: 'write',
        input: t.Object({ text: t.String() }, { additionalProperties: false }),
        output: t.Object({ noteId: t.String() }, { additionalProperties: false }),
        http: { method: 'POST', path: '/v1/notes' },
        actorKinds: ['user', 'service'],
      },
      async () => ok({ noteId: 'n1' })
    )
    .build();
  const claims = {
    sub: 'client@clients',
    client_id: 'client',
    org_id: 'org_1234567890abcdef',
    scope: 'notes:notes:write',
  };
  const handle = createHttpHandler(app, { verify: async () => claims });
  const queued = producer();
  const work: Promise<unknown>[] = [];
  const response = await handle(
    new Request('https://notes.example.test/v1/notes', {
      method: 'POST',
      headers: { authorization: 'Bearer a.b.c', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Renew the domain' }),
    }),
    { CAPTURE: queued },
    { waitUntil: (promise) => work.push(promise) }
  );
  expect(response.status).toBe(200);
  await Promise.all(work);
  expect(queued.sent).toHaveLength(1);
  expect(queued.sent[0]).toMatchObject({
    message: {
      service: 'notes',
      operation: 'createNote',
      organizationId: 'org_1234567890abcdef',
      outcome: 'success',
      input: { text: 'Renew the domain' },
      output: { noteId: 'n1' },
    },
    options: { contentType: 'json' },
  });
});
