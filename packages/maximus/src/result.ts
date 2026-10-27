/**
 * Results: the explicit outcome of every operation, a success with its value or a failure with its error.
 */
import type { Failure } from './errors.ts';
import { isRecord } from './internal/record.ts';

/** A successful outcome and its value. Each transport presents it in its own envelope. */
export interface Success<T> {
  /** Always `true`, which marks a success. */
  ok: true;
  /** What the success carries, such as an operation's output. */
  value: T;
}
/** A failed outcome and its error. */
export interface FailureResult<E> {
  /** Always `false`, which marks a failure. */
  ok: false;
  /** What went wrong, usually a catalog failure from `catalog.someFailure.create()`. */
  error: E;
}
/**
 * What an operation returns: a success with its value or a failure with its error. Expected failures are
 * results, never exceptions.
 */
export type Result<T, E> = Success<T> | FailureResult<E>;
/** A success carrying `value`. */
export function ok<T>(value: T): Success<T> {
  return { ok: true, value };
}
/** A failure carrying `error`, usually `catalog.someFailure.create()`. */
export function err<E>(error: E): FailureResult<E> {
  return { ok: false, error };
}

/**
 * Whether an untrusted answer (a Service Binding's, a stored one) is a Maximus Result: a success with
 * its value, or a failure with a well-formed error. Anything else is not an answer at all.
 */
export function isResult(value: unknown): value is Result<unknown, Failure> {
  if (!isRecord(value)) {
    return false;
  }
  if (value.ok === true) {
    return 'value' in value;
  }
  const { error } = value;
  return (
    value.ok === false &&
    isRecord(error) &&
    typeof error.code === 'string' &&
    typeof error.message === 'string' &&
    typeof error.retryable === 'boolean' &&
    isRecord(error.data)
  );
}
