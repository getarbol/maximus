/**
 * Webhook signatures at their edges: byte bodies and secrets (a view signs only its own bytes), base64url,
 * unpadded, prefixed and malformed signatures, timestamps at and beyond the tolerance in either direction,
 * the clock defaulting to now, stray header parts, rotated and foreign signature labels and as many as a
 * rotation needs, Standard Webhooks ids, secrets and `svix-` headers, every comparison made by Web Crypto and
 * none before a header is admitted, a missing secret thrown as the deployment's mistake, and refusals that
 * carry only their reason.
 */
import { createHmac } from 'node:crypto';

import { expect, it, vi } from 'vite-plus/test';

import {
  DEFAULT_TOLERANCE_SECONDS,
  MAX_SIGNATURES,
  WEBHOOK_SIGNATURE_FAILURES,
  verifyHmacSignature,
  verifyStandardWebhook,
  verifyTimestampedSignature,
  webhookSignatureFailure,
} from '../../src/webhooks.ts';

const body = '{"event":"invoice.paid","amount":1200}';
const secret = 'WEBHOOK_SECRET_SENTINEL';
const T = 1_800_000_000;
const now = () => T * 1000;
const hmac = (message: string | Uint8Array, key: string | Uint8Array = secret) =>
  createHmac('sha256', key).update(message);
/** A `t=…,v1=…` signature of `payload` at `timestamp`. */
const stamped = (timestamp: number, payload = body) => hmac(`${timestamp}.${payload}`).digest('hex');
/** The reason a verification was refused, or `ok`. */
const reason = (result: { ok: boolean; error?: { data: { reason: string } } }) =>
  result.ok ? 'ok' : result.error?.data.reason;

it('verifies a byte body with a byte secret, signing only the bytes a view covers', async () => {
  const encoder = new TextEncoder();
  const key = encoder.encode('a-byte-secret');
  const buffer = encoder.encode(`--${body}--`);
  const view = buffer.subarray(2, -2);
  const signature = hmac(body, key).digest('hex');
  expect(await verifyHmacSignature({ body: view, encoding: 'hex', secret: key, signature })).toEqual({
    ok: true,
    value: null,
  });
  // A signature of the whole buffer around the view is not the view's.
  const whole = hmac(buffer, key).digest('hex');
  expect(
    reason(await verifyHmacSignature({ body: view, encoding: 'hex', secret: key, signature: whole }))
  ).toBe('mismatch');
  expect(
    reason(
      await verifyTimestampedSignature({
        body: encoder.encode(body),
        header: `t=${T},v1=${stamped(T)}`,
        labels: ['v1'],
        now,
        secret: encoder.encode(secret),
      })
    )
  ).toBe('ok');
});

it('accepts base64url, unpadded and prefixed signatures, and refuses malformed ones without computing an HMAC', async () => {
  const digest = hmac(body).digest();
  const verify = (signature: string | undefined) =>
    verifyHmacSignature({ body, encoding: 'base64', secret, signature });
  expect(reason(await verify(digest.toString('base64url')))).toBe('ok');
  expect(reason(await verify(digest.toString('base64').replace(/[=]+$/, '')))).toBe('ok');
  expect(reason(await verify(` ${digest.toString('base64')} `))).toBe('ok');
  // A scheme prefix, as `X-Hub-Signature-256: sha256=<hex>` carries, is removed before the signature is read.
  const prefixed = `sha256=${digest.toString('hex')}`;
  expect(
    reason(
      await verifyHmacSignature({ body, encoding: 'hex', prefix: 'sha256=', secret, signature: prefixed })
    )
  ).toBe('ok');
  const computed = vi.spyOn(crypto.subtle, 'verify');
  try {
    expect(reason(await verify(undefined))).toBe('missing');
    expect(reason(await verify(''))).toBe('missing');
    // Blank, foreign characters, padding inside, and lengths base64 cannot have.
    for (const signature of ['   ', '***', 'AB=C', 'A', 'AAAAA==', 'AAAA===']) {
      expect(reason(await verify(signature)), signature).toBe('malformed');
    }
    for (const signature of ['abc', 'zz', `${hmac(body).digest('hex')}0`]) {
      expect(reason(await verifyHmacSignature({ body, encoding: 'hex', secret, signature })), signature).toBe(
        'malformed'
      );
    }
    expect(computed).not.toHaveBeenCalled();
  } finally {
    computed.mockRestore();
  }
});

it('refuses a timestamped header that is absent, or without a timestamp or a valid signature of an accepted label', async () => {
  const verify = (header: string | null) =>
    verifyTimestampedSignature({ body, header, labels: ['v1'], now, secret });
  expect(reason(await verify(null))).toBe('missing');
  expect(reason(await verify(''))).toBe('missing');
  for (const header of [
    `v1=${stamped(T)}`,
    `t=${T}`,
    `t=${T},v1=zz`,
    `t=${T},v2=${stamped(T)}`,
    // Milliseconds and signs are not Unix seconds.
    `t=${T * 1000},v1=${stamped(T)}`,
    `t=-${T},v1=${stamped(T)}`,
  ]) {
    expect(reason(await verify(header)), header).toBe('malformed');
  }
  // Parts without a key are skipped, so stray separators hide no valid signature.
  expect(reason(await verify(`,=junk,t=${T},garbage,v1=${stamped(T)},`))).toBe('ok');
  // A rotation sends two or three signatures: a header with more is refused before any HMAC is computed.
  const decoys = (count: number) => Array.from({ length: count }, () => `v1=${'0'.repeat(64)}`);
  expect(reason(await verify([`t=${T}`, ...decoys(MAX_SIGNATURES - 1), `v1=${stamped(T)}`].join(',')))).toBe(
    'ok'
  );
  const computed = vi.spyOn(crypto.subtle, 'verify');
  try {
    expect(reason(await verify([`t=${T}`, ...decoys(MAX_SIGNATURES), `v1=${stamped(T)}`].join(',')))).toBe(
      'malformed'
    );
    expect(computed).not.toHaveBeenCalled();
  } finally {
    computed.mockRestore();
  }
});

it('refuses a timestamp beyond the tolerance in either direction before any HMAC, and admits one at its edge', async () => {
  const verify = (timestamp: number, toleranceSeconds?: number) =>
    verifyTimestampedSignature({
      body,
      header: `t=${timestamp},v1=${stamped(timestamp)}`,
      labels: ['v1'],
      now,
      secret,
      ...(toleranceSeconds === undefined ? {} : { toleranceSeconds }),
    });
  expect(DEFAULT_TOLERANCE_SECONDS).toBe(300);
  expect(reason(await verify(T - 300))).toBe('ok');
  expect(reason(await verify(T + 300))).toBe('ok');
  const computed = vi.spyOn(crypto.subtle, 'verify');
  try {
    // A replayed delivery and one signed in the future are refused alike.
    expect(reason(await verify(T - 301))).toBe('expired');
    expect(reason(await verify(T + 301))).toBe('expired');
    expect(reason(await verify(T - 61, 60))).toBe('expired');
    expect(computed).not.toHaveBeenCalled();
  } finally {
    computed.mockRestore();
  }
  expect(reason(await verify(T - 60, 60))).toBe('ok');
});

it('signs the timestamp with the body, so no other timestamp or body matches, and tries every signature', async () => {
  const computed = vi.spyOn(crypto.subtle, 'verify');
  try {
    const header = `t=${T},v1=${stamped(T - 1000)},v1=${stamped(T, `${body} `)}`;
    expect(reason(await verifyTimestampedSignature({ body, header, labels: ['v1'], now, secret }))).toBe(
      'mismatch'
    );
    // Each comparison is Web Crypto's own: no userland comparison can leak timing.
    expect(computed).toHaveBeenCalledTimes(2);
    expect(computed.mock.calls.every(([algorithm]) => algorithm === 'HMAC')).toBe(true);
  } finally {
    computed.mockRestore();
  }
  // Rotation: any accepted label may carry the matching signature, and a match answers the signed time.
  const rotated = `t=${T},v0=${'0'.repeat(64)},v1=${stamped(T)}`;
  expect(
    await verifyTimestampedSignature({ body, header: rotated, labels: ['v0', 'v1'], now, secret })
  ).toEqual({ ok: true, value: { timestamp: T } });
});

it('reads the clock when no clock is given', async () => {
  const current = Math.floor(Date.now() / 1000);
  const verify = (timestamp: number) =>
    verifyTimestampedSignature({
      body,
      header: `t=${timestamp},v1=${stamped(timestamp)}`,
      labels: ['v1'],
      secret,
    });
  expect(reason(await verify(current))).toBe('ok');
  expect(reason(await verify(current - 3600))).toBe('expired');
});

/** A Standard Webhooks key, its secret as a provider shows it, and a delivery signed with it. */
const key = Buffer.from('a-standard-webhooks-secret');
const standardSecret = `whsec_${key.toString('base64')}`;
const id = 'msg_2q8';
const signed = (messageId: string, timestamp: number | string, payload = body) =>
  hmac(`${messageId}.${timestamp}.${payload}`, key).digest('base64');
/** Verifies a Standard Webhooks delivery with these headers. */
const deliver = (headers: Record<string, string>, options: { secret?: string; now?: () => number } = {}) =>
  verifyStandardWebhook({ body, now, secret: standardSecret, headers: new Headers(headers), ...options });
/** The three headers of a delivery signed at `timestamp`, with its signature header replaced when given. */
const delivery = (
  timestamp: number | string = T,
  signature = `v1,${signed(id, timestamp)}`,
  messageId = id
) => ({
  'webhook-id': messageId,
  'webhook-timestamp': String(timestamp),
  'webhook-signature': signature,
});

it('refuses a Standard Webhooks delivery whose id or timestamp is malformed, before its time is read', async () => {
  for (const timestamp of ['12a', `${T}000`, '-1', '1.8e9']) {
    expect(reason(await deliver(delivery(timestamp))), timestamp).toBe('malformed');
  }
  // A dot or a space would move the boundaries of the signed `<id>.<timestamp>.` text.
  for (const messageId of ['msg.1', 'msg 1', 'x'.repeat(257)]) {
    expect(reason(await deliver(delivery(T, `v1,${signed(messageId, T)}`, messageId))), messageId).toBe(
      'malformed'
    );
  }
  const longest = 'x'.repeat(256);
  expect(await deliver(delivery(T, `v1,${signed(longest, T)}`, longest))).toEqual({
    ok: true,
    value: { id: longest, timestamp: T },
  });
  expect(reason(await deliver({ ...delivery(), 'webhook-timestamp': '' }))).toBe('missing');
});

it('refuses a Standard Webhooks delivery beyond the tolerance either way, and reads the clock when none is given', async () => {
  expect(reason(await deliver(delivery(T - 301)))).toBe('expired');
  expect(reason(await deliver(delivery(T + 301)))).toBe('expired');
  expect(reason(await deliver(delivery(T + 300)))).toBe('ok');
  const current = Math.floor(Date.now() / 1000);
  const headers = new Headers(delivery(current));
  expect(reason(await verifyStandardWebhook({ body, secret: standardSecret, headers }))).toBe('ok');
  expect(
    reason(
      await verifyStandardWebhook({
        body,
        secret: standardSecret,
        headers: new Headers(delivery(current - 3600)),
      })
    )
  ).toBe('expired');
});

it('takes the secret with or without its whsec_ prefix, and refuses one that is not base64', async () => {
  expect(reason(await deliver(delivery(), { secret: key.toString('base64') }))).toBe('ok');
  for (const malformed of ['whsec_***', '%%%']) {
    expect(reason(await deliver(delivery(), { secret: malformed })), malformed).toBe('malformed');
  }
});

it('reads the svix- spelling of each Standard Webhooks header', async () => {
  const svix = Object.fromEntries(
    Object.entries(delivery()).map(([name, value]) => [name.replace('webhook-', 'svix-'), value])
  );
  expect(await deliver(svix)).toEqual({ ok: true, value: { id, timestamp: T } });
});

it('throws for a missing or empty secret, which anyone could sign with, before reading any header', async () => {
  const missing = new TypeError('A webhook secret is required; check the binding that holds it.');
  const computed = vi.spyOn(crypto.subtle, 'verify');
  try {
    // A binding the deployment lacks reads as undefined, whatever its declared type.
    for (const empty of ['', new Uint8Array(0), undefined as unknown as string]) {
      await expect(
        verifyHmacSignature({ body, encoding: 'hex', secret: empty, signature: hmac(body, '').digest('hex') })
      ).rejects.toThrow(missing);
      await expect(
        verifyTimestampedSignature({ body, header: null, labels: ['v1'], now, secret: empty })
      ).rejects.toThrow(missing);
    }
    for (const empty of ['', 'whsec_', undefined as unknown as string]) {
      await expect(deliver(delivery(), { secret: empty })).rejects.toThrow(missing);
    }
    expect(computed).not.toHaveBeenCalled();
  } finally {
    computed.mockRestore();
  }
});

it('reads only v1 signatures that decode, and signs the id, so a replay under another id never matches', async () => {
  const signature = signed(id, T);
  // A newer version, an empty value, an undecodable one and a lookalike label are not signatures.
  expect(reason(await deliver(delivery(T, `v2,${signature} v1, v1,*** v1a,${signature}`)))).toBe('malformed');
  expect(reason(await deliver(delivery(T, `v2,${signature} v1,${signature}`)))).toBe('ok');
  expect(reason(await deliver(delivery(T, `v1,${signature}`, 'msg_other')))).toBe('mismatch');
  const computed = vi.spyOn(crypto.subtle, 'verify');
  try {
    const decoys = Array.from({ length: MAX_SIGNATURES }, () => `v1,${Buffer.alloc(32).toString('base64')}`);
    expect(reason(await deliver(delivery(T, [...decoys, `v1,${signature}`].join(' '))))).toBe('malformed');
    expect(computed).not.toHaveBeenCalled();
  } finally {
    computed.mockRestore();
  }
});

it('describes every refusal by its reason alone, never the body, the secret or a header value', async () => {
  const refusals = [
    await verifyHmacSignature({ body, encoding: 'hex', secret, signature: 'f'.repeat(64) }),
    await verifyTimestampedSignature({
      body,
      header: `t=${T},v1=${'e'.repeat(64)}`,
      labels: ['v1'],
      now,
      secret,
    }),
    await deliver(delivery(T, `v1,${signed('msg_other', T)}`)),
  ];
  for (const refusal of refusals) {
    expect(refusal).toEqual({ ok: false, error: webhookSignatureFailure('mismatch') });
    const text = JSON.stringify(refusal);
    for (const leaked of [secret, body, 'eeee', 'ffff', standardSecret]) {
      expect(text).not.toContain(leaked);
    }
  }
  expect(webhookSignatureFailure('expired')).toEqual({
    code: 'WEBHOOK_SIGNATURE_INVALID',
    message: 'Webhook signature could not be verified',
    retryable: false,
    data: { reason: 'expired' },
  });
  expect(WEBHOOK_SIGNATURE_FAILURES).toEqual(['missing', 'malformed', 'expired', 'mismatch']);
});
