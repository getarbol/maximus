/**
 * An attachment as the typed client hands it out: a Response whose body is held to the length its headers
 * declare.
 */
import { exactLength } from '../internal/exact-length.ts';

/** Bound raw response streams without buffering or trusting an unbounded/chunked attachment. */
export function boundedAttachment(response: Response, maxBytes: number): Response {
  const rawLength = response.headers.get('content-length');
  if (
    !rawLength ||
    !/^\d+$/u.test(rawLength) ||
    !Number.isSafeInteger(Number(rawLength)) ||
    Number(rawLength) > maxBytes
  ) {
    throw new Error('Invalid attachment length.');
  }
  const length = Number(rawLength);
  if (!response.body) {
    if (length !== 0) {
      throw new Error('Missing attachment body.');
    }
    return response;
  }
  // The declared length is at most maxBytes, so holding the stream to it also bounds it.
  return new Response(exactLength(response.body, length), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
