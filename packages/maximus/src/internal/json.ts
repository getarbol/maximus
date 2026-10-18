/**
 * Bounded JSON readers for request and response bodies, media type parsing, and a bounded Retry-After
 * hint.
 */
import type { Result } from '../result.ts';
import { httpBodyFailure, readBodyText } from './body.ts';
import type { HttpBodyFailure } from './body.ts';

/** The media type of a Content-Type value, lowercased and without its parameters. */
export function mediaType(contentType: string | null): string | undefined {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase();
}

/** `application/json`, or a structured `+json` type such as `application/problem+json`. */
export function isJsonMediaType(value: string | null): boolean {
  const type = mediaType(value);
  return type === 'application/json' || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(type ?? '');
}

/** Decode bounded JSON into unknown for the owner's input/output validator. */
export async function readJsonBody(
  source: Pick<Request, 'body' | 'headers'>,
  options: {
    maxBytes: number;
    signal?: AbortSignal;
    allowJsonSuffix?: boolean;
  }
): Promise<Result<unknown, HttpBodyFailure>> {
  const contentType = source.headers.get('content-type');
  const accepted = options.allowJsonSuffix
    ? isJsonMediaType(contentType)
    : mediaType(contentType) === 'application/json';
  if (!accepted) {
    void source.body?.cancel().catch(() => {});
    return { ok: false, error: httpBodyFailure('unexpected_content_type') };
  }
  const text = await readBodyText(source, options);
  if (!text.ok) {
    return text;
  }
  try {
    return { ok: true, value: JSON.parse(text.value) };
  } catch {
    return { ok: false, error: httpBodyFailure('invalid_json') };
  }
}

/** Pass the same deadline to fetch; empty 204/205 responses have no JSON body. */
export async function readJsonResponse(
  response: Response,
  options: { maxBytes: number; signal: AbortSignal }
): Promise<Result<unknown, HttpBodyFailure>> {
  if (options.signal.aborted) {
    void response.body?.cancel().catch(() => {});
    return { ok: false, error: httpBodyFailure('aborted') };
  }
  if (response.status === 204 || response.status === 205) {
    return { ok: true, value: null };
  }
  return await readJsonBody(response, { ...options, allowJsonSuffix: true });
}

/** Bounded Retry-After hint only. A hint never makes repeating a mutation safe. */
export function retryAfterSeconds(value: string | null, nowMs: number, maximum = 3600): number | undefined {
  if (!value || !Number.isFinite(nowMs) || !Number.isSafeInteger(maximum) || maximum < 0) {
    return;
  }
  const seconds = /^\d+$/.test(value.trim()) ? Number(value.trim()) : (Date.parse(value) - nowMs) / 1000;
  return Number.isFinite(seconds) ? Math.min(maximum, Math.max(0, Math.ceil(seconds))) : undefined;
}
