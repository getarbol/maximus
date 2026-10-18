/**
 * `@arbol-ai/maximus/body`: bounded readers of Web API bodies, request and response, safe in a browser.
 */
export { readBodyText, readBodyBytes } from './internal/body.ts';
export type { BodyReadOptions, HttpBodyFailure, HttpBodyFailureReason } from './internal/body.ts';
export { readJsonResponse, readJsonBody, retryAfterSeconds, isJsonMediaType } from './internal/json.ts';
