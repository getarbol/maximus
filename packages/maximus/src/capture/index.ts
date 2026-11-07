/**
 * `@arbol-ai/maximus/capture`: one complete record of every operation call and every refusal, on every
 * transport, for a store the application declares. It is a destination apart from logs and observers, which
 * still receive metadata alone: a field whose schema says `secret: true` never reaches it, and neither does a
 * token, a raw request body or an attachment's bytes.
 */
import type { AnyContext, CaptureConfig } from '../capture.ts';
import type { RegisteredEnv } from '../handler.ts';

export type { CaptureConfig, CaptureDimensions, CaptureInvocation, CaptureSink } from '../capture.ts';
export { CaptureRecordSchema } from '../capture-record.ts';
export type { CaptureRecord } from '../capture-record.ts';
export { withoutSecrets } from '../secrets.ts';
export { pipeline } from './pipeline.ts';
export type { PipelineOptions } from './pipeline.ts';

/** The fields `capture.ts` states. */
const CAPTURE_FIELDS: ReadonlySet<string> = new Set(['enabled', 'sink', 'payloads', 'dimensions']);

/**
 * Declares, as `capture.ts`'s default export, whether calls are captured (`enabled`), where the records go
 * (`sink`), whether they carry each input and output (`payloads`) and what each call is about (`dimensions`).
 * `C` names the context `dimensions` reads, `PreparedContext<typeof context>`, importing the type alone. Any other
 * field throws a TypeError.
 */
export function defineCapture<C = AnyContext>(
  capture: CaptureConfig<RegisteredEnv, C>
): CaptureConfig<RegisteredEnv, C> {
  const unknown = Object.keys(capture).filter((field) => !CAPTURE_FIELDS.has(field));
  if (unknown.length) {
    throw new TypeError(
      `capture.ts states only enabled, sink, payloads and dimensions: remove ${unknown.join(', ')}.`
    );
  }
  return Object.freeze(capture);
}
