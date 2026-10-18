/**
 * `@arbol-ai/maximus/client`: the typed HTTP client. Its methods are inferred from the application's type
 * alone, and its routes come from the service's live OpenAPI document.
 */
import { isInputHeaderName, isPathParameterValue, operationPathParameters } from '../http-paths.ts';
import type { Static, Failure, OperationShape } from '../index.ts';
import { readJsonResponse } from '../internal/json.ts';
import { boundedAttachment } from './attachment-response.ts';
import { awaitWithSignal } from './operation-abort.ts';
import { readOperationEnvelope } from './response-envelope.ts';

/** What every HTTP operation answers: its data on success, its failure otherwise, and the request id. */
export type Envelope<T> =
  | { success: true; data: T; error: null; metadata: { requestId: string } }
  | { success: false; data: null; error: Failure; metadata: { requestId: string } };
/** The part of an application the client's types read: its operations. `typeof app` satisfies it. */
export type ClientManifest = {
  /** The application's operations by name; each one public over HTTP becomes a client method of that name. */
  operations: Record<string, OperationShape>;
};
/** Public HTTP operation identifiers derive from the service's native manifest. */
export type OperationName<M extends ClientManifest> = Extract<
  {
    [K in keyof M['operations']]: M['operations'][K] extends { http: object }
      ? M['operations'][K] extends { visibility: 'internal' }
        ? never
        : K
      : never;
  }[keyof M['operations']],
  string
>;
/** Read effects include POST searches; transport method does not determine cache ownership. */
export type ReadOperationName<M extends ClientManifest> = {
  [K in OperationName<M>]: M['operations'][K] extends { effect: 'read' } ? K : never;
}[OperationName<M>];
/** The complete declared input includes item path and mapped metadata-header fields. */
export type OperationInput<M extends ClientManifest, K extends OperationName<M>> = Static<
  M['operations'][K]['input']
>;
/** JSON outputs retain their native schema type; validated attachments expose the Web Response API. */
export type OperationOutput<M extends ClientManifest, K extends OperationName<M>> = ClientOutput<
  M['operations'][K]
>;
/** Whether a method answers the whole envelope or only its data. */
export type ResponseMode = 'envelope' | 'data';
/** What one method answers in a response mode. */
type ClientResponse<O extends OperationShape, Mode extends ResponseMode> = Mode extends 'data'
  ? ClientOutput<O>
  : Envelope<ClientOutput<O>>;
/**
 * The typed client of an application: one method per public HTTP operation. A byte operation also takes its
 * body in the call options.
 */
export type AppClientContract<M extends ClientManifest, Mode extends ResponseMode = 'envelope'> = {
  [K in OperationName<M>]: M['operations'][K] extends { http: { body: 'bytes' } }
    ? (
        input: OperationInput<M, K>,
        options: BinaryCallOptions
      ) => Promise<ClientResponse<M['operations'][K], Mode>>
    : (
        input: OperationInput<M, K>,
        options?: CallOptions
      ) => Promise<ClientResponse<M['operations'][K], Mode>>;
};
/** An operation's output as the client returns it: its declared type, or a Response for an attachment. */
type ClientOutput<Operation extends OperationShape> = Operation extends { http: { response: 'attachment' } }
  ? Response
  : Static<Operation['output']>;
/** Options of one call: a signal that cancels it. */
export interface CallOptions {
  /** Cancels this call when it aborts, as do the client's `timeoutMs` deadline and its `signal` option. */
  signal?: AbortSignal;
}
/** Options of one call to a byte operation: its body and the transfer's progress. */
export interface BinaryCallOptions extends CallOptions {
  /**
   * The bytes to upload; without a mapped `content-type` input field, a `Blob`'s own type is sent, else
   * `application/octet-stream`.
   */
  body: Blob | Uint8Array<ArrayBuffer>;
  /** Transfer lifecycle only: 0 when sending begins, 1 after a validated success response; not byte progress. */
  onUploadProgress?: (share: 0 | 1) => void;
}
/** Progress observes validated transfer lifecycle; callback failure cannot replay or change a request. */
function notifyUploadTransfer(upload: BinaryCallOptions | undefined, share: 0 | 1): void {
  try {
    upload?.onUploadProgress?.(share);
  } catch {
    /* Observation cannot change the transfer. */
  }
}
/** One operation's route as the client reads it from the OpenAPI document. */
interface DiscoveredRoute {
  /** The operation's path template, such as `/v1/notes/{noteId}`, below the base URL's own path. */
  path: string;
  /** The HTTP method in upper case: `GET`, `POST`, `PUT`, `PATCH` or `DELETE`. */
  method: string;
  /**
   * The names of the path's `{parameter}` segments, in order, each filled from the input field of that name.
   */
  parameters: readonly string[];
  /**
   * `'bytes'` when the operation takes raw bytes as its body (`x-body`); its other input fields then travel
   * in the query or headers.
   */
  body?: 'bytes';
  /**
   * `'attachment'` when a success answers raw bytes (`x-response`) instead of a JSON envelope; a refusal is
   * still an envelope.
   */
  response?: 'attachment';
  /**
   * The input fields a byte upload sends as request headers, each mapped to its header name
   * (`x-input-headers`); empty otherwise.
   */
  headers: Readonly<Record<string, string>>;
}
/** The response body limit when the client sets none: 1 MiB. */
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
/** The largest response body limit a client may set: 16 MiB. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** A validated native refusal; applications select finite, localized presentation without parsing responses. */
export interface ClientFailure {
  /** Actual HTTP status, including a refusal whose protocol body could not be decoded. */
  status: number;
  /** Validated native failure, or the canonical internal failure for malformed refusal bodies. */
  failure: Failure;
  /** Technical UUID/edge-ray correlation; empty when the response provides no valid identifier. */
  requestId: string;
}
/**
 * How the client answers, authenticates, times out and bounds what it reads, and the hooks around each
 * request.
 */
export interface ClientOptions {
  /** Data mode rejects native refusals; omitted mode preserves typed success/failure envelopes. */
  response?: ResponseMode;
  /** Captured once at operation entry, before discovery or token acquisition can await. */
  signal?: () => AbortSignal;
  /** Optional application presentation of an already validated refusal, used only in data mode. */
  onFailure?: (refusal: ClientFailure) => Error;
  /**
   * The fetch implementation every request goes through, the global `fetch` by default; for tests or a
   * Service Binding's `fetch`.
   */
  fetch?: typeof fetch;
  /**
   * The deadline of each call in milliseconds, discovery and token acquisition included; 30000 by default.
   */
  timeoutMs?: number;
  /** Headers may be augmented; method, URL, body, bearer and declared metadata remain client-owned. */
  beforeRequest?: (request: Request) => void | Promise<void>;
  /** Receives the same request object, including admitted request headers for consistency cursors. */
  afterResponse?: (response: Response, request: Request) => void | Promise<void>;
  /**
   * The Fetch credentials mode, `'omit'` by default. Its values are written out because the Workers and
   * Node type libraries declare no `RequestCredentials`.
   */
  credentials?: 'omit' | 'same-origin' | 'include';
  /** The Fetch cache mode, `'no-store'` by default; written out for the same reason (`RequestCache`). */
  cache?: 'default' | 'no-store' | 'reload' | 'no-cache' | 'force-cache' | 'only-if-cached';
  /** Raw attachments are bounded independently of small JSON metadata responses; defaults to 16 MiB. */
  maxAttachmentBytes?: number;
  /** Operation response byte limit, including chunked bodies; defaults to 1 MiB and cannot exceed 16 MiB. */
  maxResponseBytes?: number;
}

/**
 * A GET input value as the service's query codec reads it back: a string as it is, a finite number, a
 * boolean as `true` or `false`, and a list of nonempty strings without commas joined by commas. Null for a
 * value a query string cannot carry.
 */
function queryValue(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && item !== '' && !item.includes(','))
    ? value.join(',')
    : null;
}

/**
 * A typed HTTP client for an application, from its type alone (`createClient<typeof app>(…)`): one
 * method per public HTTP operation, named as the operation. On its first call it reads the routes
 * from the service's live `/openapi.json` at `origin`, an HTTPS base URL that may carry a path.
 * With `response: 'data'`, a method returns the data and throws on a refusal.
 */
export function createClient<M extends ClientManifest>(
  origin: string,
  token: string | (() => Promise<string>),
  options: ClientOptions & { response: 'data' }
): AppClientContract<M, 'data'>;
/** The same, answering each call with its success or failure envelope. */
export function createClient<M extends ClientManifest>(
  origin: string,
  token: string | (() => Promise<string>),
  options?: ClientOptions & { response?: 'envelope' }
): AppClientContract<M>;
export function createClient<M extends ClientManifest>(
  origin: string,
  token: string | (() => Promise<string>),
  options: ClientOptions = {}
): AppClientContract<M, ResponseMode> {
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > MAX_RESPONSE_BYTES
  ) {
    throw new RangeError('maxResponseBytes must be an integer between 1 byte and 16 MiB.');
  }
  const maxAttachmentBytes = options.maxAttachmentBytes ?? MAX_RESPONSE_BYTES;
  if (
    !Number.isSafeInteger(maxAttachmentBytes) ||
    maxAttachmentBytes < 1 ||
    maxAttachmentBytes > MAX_RESPONSE_BYTES
  ) {
    throw new RangeError('Invalid attachment byte limit.');
  }
  const base = new URL(origin);
  // Plain HTTP only for this machine (a local `cf dev`, which Vite serves); every other origin is HTTPS.
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (
    !(base.protocol === 'https:' || (base.protocol === 'http:' && loopback)) ||
    base.username ||
    base.password ||
    !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]*$/.test(base.pathname) ||
    base.search ||
    base.hash
  ) {
    throw new TypeError('Use an HTTPS origin (plain HTTP only on localhost).');
  }
  const prefix = base.pathname.replace(/\/$/, '');
  /** A service path as a URL below the base URL's own path. */
  const serviceUrl = (path: string) => new URL(`${prefix}${path}`, base.origin);
  const transport = options.fetch ?? fetch;
  let routes: Promise<Map<string, DiscoveredRoute>> | undefined;
  /**
   * Reads every operation's route, method, byte body, attachment and header fields from the service's live
   * OpenAPI document.
   */
  async function discover() {
    const signal = AbortSignal.timeout(options.timeoutMs ?? 30_000);
    const response = await send(serviceUrl('/openapi.json'), { method: 'GET', signal }, undefined, false);
    const result = await readJsonResponse(response, { signal, maxBytes: 4 * 1024 * 1024 });
    if (
      !response.ok ||
      !result.ok ||
      !result.value ||
      typeof result.value !== 'object' ||
      !('paths' in result.value) ||
      !result.value.paths ||
      typeof result.value.paths !== 'object'
    ) {
      throw new Error('Invalid service contract.');
    }
    const found = new Map<string, DiscoveredRoute>();
    for (const [path, methods] of Object.entries(result.value.paths)) {
      if (!methods || typeof methods !== 'object') {
        throw new Error('Invalid service route.');
      }
      let parameters: string[];
      try {
        parameters = operationPathParameters(path);
      } catch {
        throw new Error('Invalid service route.');
      }
      for (const [method, operation] of Object.entries(methods)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
          continue;
        }
        if (
          !operation ||
          typeof operation !== 'object' ||
          !('operationId' in operation) ||
          typeof operation.operationId !== 'string' ||
          found.has(operation.operationId)
        ) {
          throw new Error('Invalid service operation.');
        }
        const metadata = operation as Record<string, unknown>;
        const body = metadata['x-body'];
        const responseKind = metadata['x-response'];
        if (
          (body !== undefined && body !== 'bytes') ||
          (responseKind !== undefined && responseKind !== 'attachment')
        ) {
          throw new Error('Invalid operation body contract.');
        }
        const headers = metadata['x-input-headers'] ?? {};
        if (
          !headers ||
          typeof headers !== 'object' ||
          Array.isArray(headers) ||
          Object.entries(headers).some(
            ([field, header]) => !field || typeof header !== 'string' || !isInputHeaderName(header)
          )
        ) {
          throw new Error('Invalid operation header contract.');
        }
        found.set(operation.operationId, {
          path,
          method: method.toUpperCase(),
          parameters,
          headers: headers as Record<string, string>,
          ...(body === 'bytes' ? { body } : {}),
          ...(responseKind === 'attachment' ? { response: responseKind } : {}),
        });
      }
    }
    return found;
  }
  /**
   * Sends one request with the bearer, no credentials and no cache, after the hooks: they may add headers,
   * never replace the bearer, the method, the body or the deadline.
   */
  async function send(
    url: URL,
    init: RequestInit,
    upload?: BinaryCallOptions,
    authenticated = true
  ): Promise<Response> {
    const { signal } = init;
    signal?.throwIfAborted();
    const bearer = authenticated
      ? `Bearer ${typeof token === 'string' ? token : await awaitWithSignal(token(), signal)}`
      : undefined;
    signal?.throwIfAborted();
    const request = new Request(url, {
      ...init,
      redirect: 'manual',
      credentials: options.credentials ?? 'omit',
      cache: options.cache ?? 'no-store',
    });
    await awaitWithSignal(Promise.resolve(options.beforeRequest?.(request)), signal);
    signal?.throwIfAborted();
    // Hooks cannot replace the bearer or input-derived headers, method, body or deadline.
    for (const [header, value] of new Headers(init.headers)) {
      request.headers.set(header, value);
    }
    if (bearer) {
      request.headers.set('authorization', bearer);
    } else {
      request.headers.delete('authorization');
    }
    notifyUploadTransfer(upload, 0);
    const response = await awaitWithSignal(
      transport(url, {
        ...init,
        headers: [...request.headers].length ? Object.fromEntries(request.headers) : undefined,
        redirect: 'manual',
        credentials: request.credentials,
        cache: request.cache,
      }),
      signal
    );
    await awaitWithSignal(Promise.resolve(options.afterResponse?.(response, request)), signal);
    return response;
  }
  return new Proxy(Object.create(null), {
    get(_target, name) {
      if (typeof name !== 'string' || name === 'then') {
        return undefined;
      }
      return async (input: Record<string, unknown>, callOptions?: CallOptions | BinaryCallOptions) => {
        const capturedSignal = options.signal?.();
        const signals = [
          AbortSignal.timeout(options.timeoutMs ?? 30_000),
          capturedSignal,
          callOptions?.signal,
        ].filter((signal): signal is AbortSignal => signal !== undefined);
        const signal = AbortSignal.any(signals);
        signal.throwIfAborted();
        // Reset failed discovery so a transient failure does not poison this client.
        // oxlint-disable-next-line promise/prefer-await-to-callbacks
        routes ??= discover().catch((error) => {
          routes = undefined;
          throw error;
        });
        const inventory = await awaitWithSignal(routes, signal);
        const route = inventory.get(name);
        if (!route) {
          throw new Error('Operation is not exposed over HTTP.');
        }
        const { path: declaredPath } = route;
        let path = declaredPath;
        for (const parameter of route.parameters) {
          const value = input[parameter];
          if (!isPathParameterValue(value)) {
            throw new TypeError(
              'Path values must be nonempty strings without slashes, dot segments or controls.'
            );
          }
          path = path.replace(`{${parameter}}`, encodeURIComponent(value));
        }
        const pathNames = new Set(route.parameters);
        const remaining = Object.fromEntries(
          Object.entries(input).filter(([field]) => !pathNames.has(field))
        );
        const url = serviceUrl(path);
        const metadataHeaders = new Headers();
        const query =
          route.body === 'bytes'
            ? Object.fromEntries(
                Object.entries(remaining).filter(([field]) => !Object.hasOwn(route.headers, field))
              )
            : remaining;
        if (route.body === 'bytes') {
          // A byte upload's other fields reach its input as they are written: strings only.
          for (const [key, value] of Object.entries(query)) {
            if (value === undefined) {
              continue;
            }
            if (typeof value !== 'string') {
              throw new TypeError('Query values must be strings.');
            }
            url.searchParams.set(key, value);
          }
        } else if (route.method === 'GET') {
          // A GET's fields are read back as their kinds, so numbers, booleans and lists travel as text.
          for (const [key, value] of Object.entries(query)) {
            if (value === undefined) {
              continue;
            }
            const text = queryValue(value);
            if (text === null) {
              throw new TypeError(
                'Query values must be strings, finite numbers, booleans or lists of nonempty strings without commas.'
              );
            }
            url.searchParams.set(key, text);
          }
        }
        for (const [field, header] of Object.entries(route.headers)) {
          const value = remaining[field];
          if (value === undefined) {
            continue;
          }
          if (typeof value !== 'string') {
            throw new TypeError('Header values must be strings.');
          }
          metadataHeaders.set(header, value);
        }
        let body: BodyInit | undefined;
        let upload: BinaryCallOptions | undefined;
        if (route.body === 'bytes') {
          if (
            !callOptions ||
            !('body' in callOptions) ||
            !(callOptions.body instanceof Blob || callOptions.body instanceof Uint8Array)
          ) {
            throw new TypeError('A binary body is required.');
          }
          upload = callOptions;
          ({ body } = upload);
          if (!metadataHeaders.has('content-type')) {
            metadataHeaders.set(
              'content-type',
              upload.body instanceof Blob && upload.body.type ? upload.body.type : 'application/octet-stream'
            );
          }
        } else if (route.method !== 'GET') {
          if (callOptions && 'body' in callOptions) {
            throw new TypeError('A JSON operation cannot accept a binary body.');
          }
          metadataHeaders.set('content-type', 'application/json');
          body = JSON.stringify(remaining);
        }
        const response = await send(
          url,
          { method: route.method, signal, headers: metadataHeaders, ...(body === undefined ? {} : { body }) },
          upload
        );
        if (route.response === 'attachment' && response.ok) {
          const attachment = boundedAttachment(response, maxAttachmentBytes);
          notifyUploadTransfer(upload, 1);
          return options.response === 'data'
            ? attachment
            : {
                success: true,
                data: attachment,
                error: null,
                metadata: { requestId: response.headers.get('x-request-id') ?? '' },
              };
        }
        const envelope = await readOperationEnvelope(response, {
          signal,
          maxBytes: maxResponseBytes,
          dataMode: options.response === 'data',
        });
        if (envelope.success) {
          notifyUploadTransfer(upload, 1);
        }
        if (options.response !== 'data') {
          return envelope;
        }
        if (!envelope.success) {
          const refusal = {
            status: response.status,
            failure: envelope.error,
            requestId: envelope.metadata.requestId,
          };
          throw (
            options.onFailure?.(refusal) ?? new Error('The service refused the request.', { cause: refusal })
          );
        }
        return envelope.data;
      };
    },
  }) as AppClientContract<M, ResponseMode>;
}
