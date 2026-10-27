/**
 * The tasks API under this origin's /api, called with the token the person gave. Each function calls one
 * route, is named after its operation and is typed by the route's own schemas: only types cross from the
 * server's modules into the browser.
 */
import type { Failure, Static } from '@arbol-ai/maximus';

import type { app } from '#maximus/app';

/** The application's operations, whose schemas type each call. */
type Operations = typeof app.operations;
/** The name of one of the application's operations, such as `listTasks`. */
type OperationName = keyof Operations;
/** What an operation takes. */
type Input<Name extends OperationName> = Static<Operations[Name]['input']>;
/** What an operation answers. */
type Output<Name extends OperationName> = Static<Operations[Name]['output']>;
/** The envelope of every answer: the operation's output, or the failure that refused the call. */
type Envelope<Name extends OperationName> =
  | { success: true; data: Output<Name> }
  | { success: false; error: Failure };

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
let bearerToken = '';

/** Keeps the person's token for the calls that follow. */
export function signIn(token: string): void {
  bearerToken = token;
}

/** Whether the person gave a token. */
export function isSignedIn(): boolean {
  return bearerToken !== '';
}

/**
 * Calls one operation with the token, and answers its output or throws the refusal it answered. Every write
 * sends a JSON body, `{}` when its fields are all in its path.
 */
async function call<Name extends OperationName>(
  method: string,
  path: string,
  body?: Partial<Input<Name>>
): Promise<Output<Name>> {
  const headers = new Headers({ authorization: `Bearer ${bearerToken}` });
  const request: RequestInit = { method, headers };
  if (method !== 'GET') {
    headers.set('content-type', 'application/json');
    request.body = JSON.stringify(body ?? {});
  }
  const response = await fetch(`/api${path}`, request);
  // The route's schemas type the envelope; checking it again would bring them into the browser.
  const envelope = (await response.json()) as Envelope<Name>;
  if (!envelope.success) {
    throw new RefusalError(envelope.error);
  }
  return envelope.data;
}

/** A task's path below /api. */
function taskPath(taskId: string): string {
  return `/v1/tasks/${encodeURIComponent(taskId)}`;
}

/** The organization's tasks, open and done. */
export function listTasks() {
  return call<'listTasks'>('GET', '/v1/tasks');
}

/** Adds an open task to the organization, and answers it. */
export function createTask(input: Input<'createTask'>) {
  return call<'createTask'>('POST', '/v1/tasks', input);
}

/** One task of the organization. */
export function getTask(taskId: string) {
  return call<'getTask'>('GET', taskPath(taskId));
}

/** Marks a task done, and answers it. */
export function completeTask(taskId: string) {
  return call<'completeTask'>('POST', `${taskPath(taskId)}/complete`);
}

/** Deletes a task. */
export function deleteTask(taskId: string) {
  return call<'deleteTask'>('DELETE', taskPath(taskId));
}
