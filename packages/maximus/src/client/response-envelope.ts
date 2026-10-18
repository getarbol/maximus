/**
 * Reads an operation's response envelope as the typed client receives it, checking its shape and its
 * status before any data or failure reaches the caller.
 */
import { standardErrors, isRequestId } from '../errors.ts';
import type { Failure } from '../index.ts';
import { readJsonResponse } from '../internal/json.ts';
import { isRecord } from '../internal/record.ts';
import type { Envelope } from './client.ts';

/**
 * Whether a value is a well-formed failure: exactly code, message, retryable and data, with a printable code.
 */
const failure = (value: unknown): value is Failure =>
  isRecord(value) &&
  Object.keys(value).length === 4 &&
  typeof value.code === 'string' &&
  value.code.length > 0 &&
  value.code.length <= 128 &&
  !/\p{Cc}/u.test(value.code) &&
  typeof value.message === 'string' &&
  typeof value.retryable === 'boolean' &&
  isRecord(value.data);

/** Validate protocol discriminants and status consistency before data or refusal reaches a caller. */
export function responseEnvelope(value: unknown, status: number): Envelope<unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    !Object.hasOwn(value, 'data') ||
    !isRecord(value.metadata) ||
    Object.keys(value.metadata).length !== 1 ||
    !isRequestId(value.metadata.requestId)
  ) {
    throw new Error(`Invalid service response (${status}).`);
  }
  const metadata = { requestId: value.metadata.requestId };
  if (value.success === true && value.error === null && status >= 200 && status < 300) {
    return { success: true, data: value.data, error: null, metadata };
  }
  if (
    value.success === false &&
    value.data === null &&
    failure(value.error) &&
    status >= 400 &&
    status <= 599
  ) {
    return { success: false, data: null, error: value.error, metadata };
  }
  throw new Error(`Invalid service response (${status}).`);
}

/** The largest refusal body the client reads, whatever its success limit. */
const MAX_FAILURE_BYTES = 16 * 1024;
/** Refusal decoding never grants a successful operation's larger body budget or exposes unvalidated server text. */
export async function readOperationEnvelope(
  response: Response,
  options: { signal: AbortSignal; maxBytes: number; dataMode: boolean }
): Promise<Envelope<unknown>> {
  const result = await readJsonResponse(response, {
    signal: options.signal,
    maxBytes: response.ok ? options.maxBytes : Math.min(options.maxBytes, MAX_FAILURE_BYTES),
  });
  options.signal.throwIfAborted();
  try {
    if (!result.ok) {
      throw new Error(`Invalid service response (${response.status}).`);
    }
    return responseEnvelope(result.value, response.status);
  } catch (error) {
    if (!options.dataMode || response.ok) {
      throw error;
    }
    const requestId = response.headers.get('x-request-id');
    return {
      success: false,
      data: null,
      error: standardErrors.internal.create(),
      metadata: { requestId: isRequestId(requestId) ? requestId : '' },
    };
  }
}
