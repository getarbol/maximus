/**
 * `@arbol-ai/maximus/body`: bounded readers of Web API bodies, request and response, and the URLs a Worker may
 * send a request to for someone it does not control, safe in a browser.
 */
export { readBodyText, readBodyBytes } from './internal/body.ts';
export { publicDestination } from './internal/destination.ts';
export type { BodyReadOptions, HttpBodyFailure, HttpBodyFailureReason } from './internal/body.ts';
export { readJsonResponse, readJsonBody, retryAfterSeconds, isJsonMediaType } from './internal/json.ts';
