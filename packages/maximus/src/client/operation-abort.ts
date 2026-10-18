/**
 * Lets a client call stop waiting when its caller aborts, without cancelling the work it waited for.
 */

/**
 * Waits for `pending` until the caller's `signal` aborts, then rejects with its reason. The pending work
 * itself goes on, so a shared one, such as route discovery, still serves the other calls.
 */
export async function awaitWithSignal<T>(pending: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) {
    return pending;
  }
  let abort: (() => void) | undefined;
  // oxlint-disable-next-line promise/avoid-new -- An AbortSignal event has no Promise; this bridge races external authentication/discovery waits.
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    if (abort) {
      signal.removeEventListener('abort', abort);
    }
  }
}
