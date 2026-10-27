/**
 * Waiting with a caller's signal: the wait ends with the signal's reason when it aborts, the work it
 * waited for goes on, and a long-lived signal keeps no listener once a wait is over.
 */
import { getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

import { expect, it } from 'vite-plus/test';

import { awaitWithSignal } from '../../src/client/operation-abort.ts';

it('answers the work itself when there is no signal', async () => {
  await expect(awaitWithSignal(Promise.resolve('done'))).resolves.toBe('done');
  await expect(awaitWithSignal(Promise.resolve('done'), null)).resolves.toBe('done');
  const failure = new Error('The work failed.');
  await expect(awaitWithSignal(Promise.reject(failure))).rejects.toBe(failure);
});

it('refuses at once when the signal has already aborted, whatever the work answers', async () => {
  const reason = new Error('The caller left.');
  await expect(awaitWithSignal(Promise.resolve('done'), AbortSignal.abort(reason))).rejects.toBe(reason);
});

it('rejects with the abort reason while the work it waited for goes on', async () => {
  const caller = new AbortController();
  const work = delay(20, 'done');
  const waiting = awaitWithSignal(work, caller.signal);
  const reason = new Error('The caller left.');
  caller.abort(reason);
  await expect(waiting).rejects.toBe(reason);
  await expect(work).resolves.toBe('done');
  expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
});

it('answers the work when it settles first, and leaves no listener on the signal', async () => {
  const lifecycle = new AbortController();
  const waiting = awaitWithSignal(delay(5, 'later'), lifecycle.signal);
  expect(getEventListeners(lifecycle.signal, 'abort')).toHaveLength(1);
  await expect(waiting).resolves.toBe('later');
  const failure = new Error('The work failed.');
  await expect(awaitWithSignal(Promise.reject(failure), lifecycle.signal)).rejects.toBe(failure);
  expect(getEventListeners(lifecycle.signal, 'abort')).toHaveLength(0);
});
