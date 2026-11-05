/**
 * A wait on the runtime's global timer, for code the core reaches: it may load where `node:timers` does not.
 */

/** Resolves after `milliseconds`. */
export function delay(milliseconds: number): Promise<void> {
  // oxlint-disable-next-line promise/avoid-new -- Every runtime the core runs in has this timer in callback form.
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
