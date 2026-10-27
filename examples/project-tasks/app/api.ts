/**
 * The tasks API, typed by the application itself: each method is a route, such as `getV1Tasks` for
 * GET /api/v1/tasks. Only types cross from the server's modules into the browser.
 */
import { createClient } from '@arbol-ai/maximus/client';
import type { ClientFailure } from '@arbol-ai/maximus/client';

import type { app } from '../.maximus/app.ts';

/** A call the API refused, with the failure it answered. */
export class RefusalError extends Error {
  /** The failure: its code, its catalog message and whether a retry may succeed. */
  readonly failure: ClientFailure['failure'];
  constructor(refusal: ClientFailure) {
    super(refusal.failure.message);
    this.name = 'RefusalError';
    this.failure = refusal.failure;
  }
}

/** The bearer token the person gave, kept in memory alone: a reload asks for it again. */
let token = '';

/** Keeps the token for the calls that follow. */
export function signIn(value: string): void {
  token = value;
}

/** Whether the person gave a token. */
export function signedIn(): boolean {
  return token !== '';
}

/** The API below this origin's /api: each call answers its data or throws its RefusalError. */
export const api = createClient<typeof app>(new URL('/api', location.origin).href, async () => token, {
  response: 'data',
  onFailure: (refusal) => new RefusalError(refusal),
});
