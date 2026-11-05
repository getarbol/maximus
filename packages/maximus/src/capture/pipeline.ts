/**
 * The sink that sends each record to a Cloudflare Pipelines stream: one retry, then, when the sink has a
 * bucket, the dead letter; a payload too large for one record goes to that bucket by reference.
 */
import type { CaptureRecord } from '../capture-record.ts';
import type { CaptureSink } from '../capture.ts';
import { delay } from '../internal/delay.ts';
import { sha256Hex } from '../internal/digest.ts';
import { isRecord } from '../internal/record.ts';

/** The largest `input`, `output` and `failureData` one record carries together, in bytes. */
const MAX_PAYLOAD_BYTES = 900_000;
/** How long the one retry waits. A stream that refuses a send usually recovers within a moment. */
const RETRY_DELAY_MILLISECONDS = 200;

/** What this sink calls of a Pipelines binding. */
interface PipelineStream {
  send: (records: unknown[]) => Promise<unknown>;
}
/** What this sink calls of an R2 binding. */
interface PayloadBucket {
  put: (
    key: string,
    value: string | Uint8Array,
    options: { httpMetadata: { contentType: string } }
  ) => Promise<unknown>;
}
/** What `pipeline()` takes. */
export interface PipelineOptions<E> {
  /**
   * The name of the Pipelines binding. While the env has no such binding, capture records nothing and logs
   * nothing, so a preview or a local run without the stream costs nothing.
   */
  binding: string;
  /**
   * Turns a record into the row the stream's schema expects: the stream gets the record itself without it. A
   * structured stream drops a row its schema refuses, so a stream of another shape needs this. An answer of
   * `null` or `undefined` sends nothing.
   */
  map?: (record: CaptureRecord, env: E) => unknown;
  /**
   * The name of an R2 binding for what the stream cannot take. A payload over 900 KB is written to
   * `payloads/<organizationId>/<id>.json`, and the record carries `payloadRef` instead; a row the stream
   * refused twice is written to `dlq/<service>/<yyyy-mm-dd>/<id>.json`, for a job to send again. Without it,
   * both count as failed deliveries.
   */
  blobs?: string;
}

/** A binding of the env, by name. */
function bindingOf(env: unknown, name: string): unknown {
  return isRecord(env) ? env[name] : undefined;
}

/** The record, with a payload over the limit written to the bucket: it fails when there is no bucket. */
async function withinLimit(record: CaptureRecord, bucket: PayloadBucket | undefined): Promise<CaptureRecord> {
  const { input, output, failureData } = record;
  const payload = new TextEncoder().encode(JSON.stringify({ input, output, failureData }));
  if (payload.byteLength <= MAX_PAYLOAD_BYTES) {
    return record;
  }
  if (!bucket) {
    throw new RangeError('A capture payload over the limit needs a blobs binding.');
  }
  const key = `payloads/${record.organizationId ?? 'platform'}/${record.id}.json`;
  await bucket.put(key, payload, { httpMetadata: { contentType: 'application/json' } });
  return {
    ...record,
    input: null,
    output: null,
    failureData: null,
    payloadRef: { $ref: key, bytes: payload.byteLength, sha256: await sha256Hex(payload) },
  };
}

/** Keeps a row the stream refused twice, for a job to send again. The record's id names it, so a replay finds one. */
async function deadLetter(record: CaptureRecord, row: unknown, bucket: PayloadBucket): Promise<void> {
  const day = new Date(record.occurredAt).toISOString().slice(0, 10);
  await bucket.put(`dlq/${record.service}/${day}/${record.id}.json`, JSON.stringify(row), {
    httpMetadata: { contentType: 'application/json' },
  });
}

/**
 * Sends each record to a Pipelines stream, the binding `env[binding]`. A send that fails is retried once after
 * 200 ms, with the same record id, then written to the dead letter when `blobs` is set; the delivery still
 * counts as failed, so the failure is logged. A stream is a durable buffer that accepts a repeated row, and a
 * consumer deduplicates on the record's id. A sink for an append whose outcome may be lost should never retry.
 */
export function pipeline<E>(options: PipelineOptions<E>): CaptureSink<E> {
  const { binding, blobs, map } = options;
  if (typeof binding !== 'string' || !binding) {
    throw new TypeError('pipeline() takes the name of a Pipelines binding.');
  }
  return {
    available: (env) =>
      typeof (bindingOf(env, binding) as Partial<PipelineStream> | undefined)?.send === 'function',
    async send(record, env) {
      const stream = bindingOf(env, binding) as PipelineStream;
      const bucket = blobs === undefined ? undefined : (bindingOf(env, blobs) as PayloadBucket | undefined);
      const carried = await withinLimit(record, bucket);
      const row = map ? await map(carried, env) : carried;
      if (row === null || row === undefined) {
        return;
      }
      try {
        await stream.send([row]);
      } catch {
        await delay(RETRY_DELAY_MILLISECONDS);
        try {
          await stream.send([row]);
        } catch (error) {
          if (bucket) {
            await deadLetter(carried, row, bucket);
          }
          throw error;
        }
      }
    },
  };
}
