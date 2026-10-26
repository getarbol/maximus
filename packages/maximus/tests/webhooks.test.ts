/**
 * Webhook signatures: raw-body HMAC, timestamped signatures and Standard Webhooks, each against tampered,
 * expired and malformed deliveries.
 */
import { createHmac } from 'node:crypto';

import { expect, it } from 'vite-plus/test';

import {
  MAX_SIGNATURES,
  verifyHmacSignature,
  verifyStandardWebhook,
  verifyTimestampedSignature,
} from '../src/webhooks.ts';

const body = '{"event":"delivered"}';
const secret = 'top-secret';
const hmac = (message: string, key: string | Buffer = secret) => createHmac('sha256', key).update(message);

it('verifies a raw-body HMAC in hex or base64, with an optional scheme prefix', async () => {
  const hex = hmac(body).digest('hex');
  expect(await verifyHmacSignature({ body, encoding: 'hex', secret, signature: hex })).toEqual({
    ok: true,
    value: null,
  });
  expect(
    await verifyHmacSignature({
      body,
      encoding: 'hex',
      prefix: 'sha256=',
      secret,
      signature: `sha256=${hex}`,
    })
  ).toMatchObject({ ok: true });
  expect(
    await verifyHmacSignature({ body, encoding: 'base64', secret, signature: hmac(body).digest('base64') })
  ).toMatchObject({ ok: true });
  const reason = async (signature: string | null) => {
    const result = await verifyHmacSignature({ body, encoding: 'hex', secret, signature });
    return result.ok ? null : result.error;
  };
  expect(await reason(null)).toMatchObject({
    code: 'WEBHOOK_SIGNATURE_INVALID',
    data: { reason: 'missing' },
  });
  expect(await reason('zz')).toMatchObject({ data: { reason: 'malformed' } });
  expect(await reason(hmac(`${body} `).digest('hex'))).toMatchObject({ data: { reason: 'mismatch' } });
});

it('verifies a timestamped signature within its tolerance, accepting any rotated value', async () => {
  const now = () => 1_800_000_000_000;
  const t = 1_800_000_000;
  const good = hmac(`${t}.${body}`).digest('hex');
  const header = `t=${t},v1=${'0'.repeat(64)},v1=${good}`;
  expect(await verifyTimestampedSignature({ body, header, labels: ['v1'], now, secret })).toEqual({
    ok: true,
    value: { timestamp: t },
  });
  expect(
    await verifyTimestampedSignature({ body, header: `t=${t - 301},v1=${good}`, labels: ['v1'], now, secret })
  ).toMatchObject({ ok: false, error: { data: { reason: 'expired' } } });
  expect(await verifyTimestampedSignature({ body, header, labels: ['v0'], now, secret })).toMatchObject({
    ok: false,
    error: { data: { reason: 'malformed' } },
  });
});

it('verifies a Standard Webhooks delivery, with webhook- or svix- headers', async () => {
  const key = Buffer.from('a-standard-webhooks-secret');
  const id = 'msg_2q8';
  const timestamp = 1_800_000_000;
  const signature = hmac(`${id}.${timestamp}.${body}`, key).digest('base64');
  const headers = new Headers({
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1,${signature}`,
  });
  const options = { body, now: () => timestamp * 1000, secret: `whsec_${key.toString('base64')}` };
  expect(await verifyStandardWebhook({ ...options, headers })).toEqual({
    ok: true,
    value: { id, timestamp },
  });
  const svix = new Headers({
    'svix-id': id,
    'svix-timestamp': String(timestamp),
    'svix-signature': `v1,${signature}`,
  });
  expect(await verifyStandardWebhook({ ...options, headers: svix })).toMatchObject({ ok: true });
  expect(await verifyStandardWebhook({ ...options, headers: new Headers() })).toMatchObject({
    ok: false,
    error: { data: { reason: 'missing' } },
  });
  expect(await verifyStandardWebhook({ ...options, body: `${body}x`, headers })).toMatchObject({
    ok: false,
    error: { data: { reason: 'mismatch' } },
  });
});

it('refuses a header with more signatures than a secret rotation needs, before computing any', async () => {
  const now = () => 1_800_000_000_000;
  const t = 1_800_000_000;
  const good = hmac(`${t}.${body}`).digest('hex');
  /** A timestamped header with `decoys` wrong signatures before the right one. */
  const timestamped = (decoys: number) =>
    [`t=${t}`, ...Array.from({ length: decoys }, () => `v1=${'0'.repeat(64)}`), `v1=${good}`].join(',');
  const verify = (header: string) =>
    verifyTimestampedSignature({ body, header, labels: ['v1'], now, secret });
  expect(await verify(timestamped(MAX_SIGNATURES - 1))).toMatchObject({ ok: true });
  expect(await verify(timestamped(MAX_SIGNATURES))).toMatchObject({
    ok: false,
    error: { data: { reason: 'malformed' } },
  });

  const key = Buffer.from('a-standard-webhooks-secret');
  const id = 'msg_2q8';
  const signature = hmac(`${id}.${t}.${body}`, key).digest('base64');
  /** A Standard Webhooks delivery with `decoys` wrong signatures before the right one. */
  const standard = (decoys: number) =>
    verifyStandardWebhook({
      body,
      now,
      secret: `whsec_${key.toString('base64')}`,
      headers: new Headers({
        'webhook-id': id,
        'webhook-timestamp': String(t),
        'webhook-signature': [
          ...Array.from({ length: decoys }, () => `v1,${Buffer.alloc(32).toString('base64')}`),
          `v1,${signature}`,
        ].join(' '),
      }),
    });
  expect(await standard(MAX_SIGNATURES - 1)).toMatchObject({ ok: true });
  expect(await standard(MAX_SIGNATURES)).toMatchObject({
    ok: false,
    error: { data: { reason: 'malformed' } },
  });
});
