/**
 * The tasks API under this origin's /api, called with the token the person gave. Each function is one
 * route, typed by the route's own schemas: only types cross from the server's modules into the browser.
 */
import type { Failure, Static } from '@arbol-ai/maximus';

import type { app } from '../.maximus/app.ts';

/** The application's operations, whose schemas type each call. */
type Operations = typeof app.operations;
/** What a route takes. */
type Input<K extends keyof Operations> = Static<Operations[K]['input']>;
/** What a route answers. */
type Output<K extends keyof Operations> = Static<Operations[K]['output']>;

/** A call the API refused, with the failure it answered. */
export class RefusalError extends Error {
  /** The failure: its code, its catalog message and whether a retry may succeed. */
  readonly failure: Failure;
  constructor(failure: Failure) {
    super(failure.message);
    this.name = 'RefusalError';
    this.failure = failure;
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

/**
 * Sends one call with the token, and answers its data or throws the refusal it answered. Every write sends
 * a JSON body, `{}` when its fields are all in its path.
 */
async function call<K extends keyof Operations>(
  method: string,
  path: string,
  body?: Partial<Input<K>>
): Promise<Output<K>> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  const envelope = (await response.json()) as
    | { success: true; data: Output<K> }
    | { success: false; error: Failure };
  if (!envelope.success) {
    throw new RefusalError(envelope.error);
  }
  return envelope.data;
}

/** A task's path below /api. */
const task = (taskId: string) => `/v1/tasks/${encodeURIComponent(taskId)}`;

/** The organization's tasks, one function per route. */
export const tasks = {
  list: () => call<'getV1Tasks'>('GET', '/v1/tasks'),
  create: (input: Input<'postV1Tasks'>) => call<'postV1Tasks'>('POST', '/v1/tasks', input),
  get: (taskId: string) => call<'getV1TasksTaskId'>('GET', task(taskId)),
  complete: (taskId: string) => call<'postV1TasksTaskIdComplete'>('POST', `${task(taskId)}/complete`),
  remove: (taskId: string) => call<'deleteV1TasksTaskId'>('DELETE', task(taskId)),
};
