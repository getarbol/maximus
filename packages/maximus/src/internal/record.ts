/**
 * The plain-record guard the readers of untrusted values share.
 */

/** Whether an untrusted value is an object with fields: neither null nor an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
