/**
 * The native HTTP handler: one `fetch` function that serves an application's operations, its
 * discovery documents (OpenAPI, OAuth protected-resource metadata, liveness), its transports (MCP),
 * plain routes and mounts. Every operation call goes through the same admission: the token, then the
 * rate limit, then the bounded body, then the shared execution path.
 */
import { stringify } from 'yaml';

import type { Attachment } from './attachment-schema.ts';
import { attachmentResponse, binaryBody } from './binary.ts';
import { standardErrors } from './errors.ts';
import type { Failure } from './errors.ts';
import { executeOperation } from './execution.ts';
import { createHttpRouteResolver } from './http-paths.ts';
import type { HttpRouteMatch } from './http-paths.ts';
import { readBodyText } from './internal/body.ts';
import { sha256Hex } from './internal/digest.ts';
import {
  composition,
  httpTransports,
  nativePaths,
  ownsPrefix,
  servesOwnBearer,
  VERSIONED_PATH,
} from './internal/http-layout.ts';
import { queryInput, queryKinds } from './internal/http-query.ts';
import type { QueryKind } from './internal/http-query.ts';
import { mediaType } from './internal/json.ts';
import {
  DEFAULT_MAX_BODY_BYTES,
  isPublicOperation,
  operationMatchesScopes,
  operationScopes,
} from './manifest.ts';
import type { AppManifest, McpConfiguration, OperationShape } from './manifest.ts';
import { protectedResourceMetadata } from './oauth.ts';
import { createOpenApi } from './openapi.ts';
import { err, ok } from './result.ts';
import type { Result } from './result.ts';
import {
  recordExecution,
  recordAdmission,
  telemetryEnabled,
  withTelemetry,
  reportUnexpected,
} from './telemetry.ts';
import type { BackgroundContext } from './telemetry.ts';
import { createTokenAuthorization, tokenAudiences, tokenIssuer } from './tokens.ts';
import type { TokenPrincipal, Principal, TokenResolutionContext } from './tokens.ts';

/**
 * What a transport receives for one admitted request: the request and its id, the verified caller, the
 * application, the operations it may serve, the OpenAPI document, and `invoke`, which runs an operation
 * through the shared execution path.
 */
export interface TransportContext {
  /**
   * The admitted request, rebuilt around the body admission read within the transport's limit, so the
   * transport can read it again.
   */
  request: Request;
  /** The request id echoed in `x-request-id`; use it to correlate diagnostics. */
  requestId: string;
  /**
   * The verified caller: its actor, actor kind, organization, granted scopes and, when known, its OAuth
   * client.
   */
  authenticated: TokenPrincipal;
  /** The application the transport serves: its name, title, version, public origin and MCP configuration. */
  application: {
    name: string;
    title: string;
    version: string;
    origin: string;
    mcp?: McpConfiguration;
  };
  /**
   * The operations the transport may run, as `[name, operation]` pairs: every operation the application
   * declares. `invoke` refuses any other.
   */
  operations: readonly [string, OperationShape][];
  /** Returns the application's OpenAPI document, the one its `/openapi.json` serves. */
  contract: () => Record<string, unknown>;
  /** The application's OpenAPI document as the JSON or YAML text `/openapi.json` or `/openapi.yaml` serves. */
  contractText: (format: 'json' | 'yaml') => string;
  /** The public URL of one of the application's own paths, such as `/openapi.json`, below its base path. */
  url: (path: string) => string;
  /**
   * Runs one of `operations` as the verified caller and answers its Result; another operation fails with
   * `NOT_FOUND`, and each later call is rate limited as its own request.
   */
  invoke: (name: string, operation: OperationShape, input: unknown) => Promise<Result<unknown, Failure>>;
  /**
   * Counts one more request this HTTP request carries, such as a JSON-RPC request of a batch, against the
   * caller's rate limit as a request of its own: false when the limit refuses it. Admission counted the
   * first, and `invoke` counts each of its calls itself.
   */
  admitRequest: () => Promise<boolean>;
  /** Bytes of the request body the transport received. */
  bodyBytes: number;
  /** The body limit HTTP applies to an operation; a transport holds each invocation to it. */
  bodyLimit: (operation: OperationShape) => number;
}
/**
 * A protocol served at one path beside the operations, such as MCP: the scope a caller needs, the body it
 * admits and its handler.
 */
export interface HttpTransport {
  /** Identifies protocol independently of its URL mount. */
  protocol?: 'mcp';
  /**
   * The exact path the transport answers, such as `/mcp`; it stays absolute when the application has a base
   * path.
   */
  path: string;
  /**
   * The scope a caller needs to use the transport, given the application's namespace; MCP's is
   * `<namespace>:mcp:use`.
   */
  scope: (namespace: string) => string;
  /**
   * The largest body the transport admits, given the operations the caller may run (those its scopes and
   * actor kind admit) and the application's limit. Omit it to keep the application's limit; a transport that
   * raises it must enforce `bodyLimit` per invocation.
   */
  maxBodyBytes?: (operations: readonly [string, OperationShape][], fallback: number) => number;
  /** Answers one request at `path`, after its token, rate limit and body have been admitted. */
  handle: (context: TransportContext) => Promise<Response>;
}
/** What a plain route receives besides the request. */
export interface RouteContext {
  /** The request id echoed in `x-request-id`; use it to correlate diagnostics. */
  requestId: string;
  /** Use the application's declared error catalog and this request's correlation for a raw protocol refusal. */
  fail: (failure: Failure, headers?: ResponseInit['headers']) => Response;
  /** Keep work running after the response (Workers `ctx.waitUntil`). Best effort: never durable. */
  waitUntil: (promise: Promise<unknown>) => void;
}
/**
 * A plain HTTP route outside token admission, for callers that cannot present a
 * bearer token: provider webhooks (signed bodies), signed links, OAuth
 * callbacks. The handler owns authentication completely: it must verify a
 * signature or token before it treats the request as data. Plain routes share
 * the handler's diagnostics, request id and security headers; they never
 * receive a principal and are absent from OpenAPI.
 */
export type HttpRoute<E> = (request: Request, env: E, context: RouteContext) => Promise<Response>;
/**
 * Wraps HTTP before token admission. The request is a bodyless metadata copy, so a wrapper cannot
 * consume unbounded input or mutate the headers native admission reads. No principal is available;
 * `next` keeps the existing pipeline and may run only once before the wrapper settles.
 */
export type HttpMiddleware<E> = (
  request: Request,
  env: E,
  context: RouteContext,
  next: () => Promise<Response>
) => Promise<Response>;
/**
 * How the HTTP handler composes the application with the rest of a Worker: exact origins, transports, plain
 * routes and mounts, a base path, a fallback and request hooks.
 */
export interface HttpOptions<E = unknown> {
  /** Ordered request wrappers, after origin admission and inside native error/security handling. */
  middleware?: readonly HttpMiddleware<E>[];
  /** Exact deployment origins; refusal precedes metadata, hooks and token admission. */
  origins?: readonly string[];
  /**
   * Test seam for the default OAuth verification: returns a token's claims in place of the JWT check; claim
   * mapping and scope checks still apply. Never deploy it.
   */
  verify?: (token: string) => Promise<unknown>;
  /**
   * Called with the operation name and request id before each operation runs, while telemetry is on;
   * `createWorker` uses it to set span attributes.
   */
  annotate?: (operation: string, requestId: string) => void;
  /**
   * Protocol transports served beside the operations, such as `mcp()`; one per path, and at most one MCP
   * transport.
   */
  transports?: readonly HttpTransport[];
  /**
   * Plain routes by exact path. Paths under `/v<n>/` and every discovery,
   * operation or transport path are reserved. A route may sit beneath a
   * transport's path (a second MCP server at `/mcp/agent-runtime`): the
   * transport answers only its exact path.
   */
  routes?: Readonly<Record<string, HttpRoute<E>>>;
  /** Mount native operations and discovery below this path; transports and plain routes remain absolute. */
  basePath?: string;
  /** Absolute public liveness path; defaults to the mounted `/health`. No dependency probes run here. */
  healthPath?: string;
  /** Prefix protocols own the prefix itself and every slash-delimited descendant. Nested mounts use the longest prefix. */
  mounts?: Readonly<Record<string, HttpRoute<E>>>;
  /** Request-local product admission, before any route or native token admission. */
  before?: (request: Request, env: E, context: RouteContext) => Response | null | Promise<Response | null>;
  /** Handles only paths outside all native, transport and mounted protocol namespaces. */
  fallback?: HttpRoute<E>;
  /** Scope a matched HTTP operation's environment. The continuation may run only once. */
  aroundOperation?: (
    request: Request,
    env: E,
    operation: Readonly<{ name: string; effect: OperationShape['effect'] }>,
    run: (scopedEnv: E) => Promise<Response>
  ) => Promise<Response>;
}

/** An operation the origin serves over REST, with the query fields a GET reads. */
interface ServedRoute {
  /** The operation's name, its key among the application's operations. */
  name: string;
  /** The operation the route runs, as the application declares it. */
  op: OperationShape;
  /** The operation's HTTP exposure, whose method and path template the router matches. */
  http: OperationShape['http'];
  /**
   * The input fields a GET reads from its query string, outside the path, each with the kind its value is
   * read as.
   */
  query: ReadonlyMap<string, QueryKind>;
}

/**
 * Serves an application over HTTP as one function, `(request, env, background?) => Promise<Response>`: its
 * operations at their routes, the OpenAPI document as JSON and YAML, OAuth discovery, `/health`, transports
 * such as MCP, plain routes and mounts. Construction refuses a path two of them would claim.
 */
export function createHttpHandler<E, C, O extends Record<string, OperationShape>>(
  manifest: AppManifest<E, C, O>,
  hooks: HttpOptions<E> = {}
) {
  if (
    hooks.origins &&
    (!hooks.origins.length ||
      hooks.origins.some((origin) => {
        const url = new URL(origin);
        return url.protocol !== 'https:' || url.origin !== origin;
      }))
  ) {
    throw new TypeError('HTTP origins must be exact HTTPS origins.');
  }
  for (const middleware of hooks.middleware ?? []) {
    if (typeof middleware !== 'function') {
      throw new TypeError('Every HTTP middleware entry must be a function.');
    }
  }
  const paths = nativePaths(manifest.tokens, hooks);
  const authorize = createTokenAuthorization(manifest.tokens, hooks.verify);
  const operations = Object.entries(manifest.operations);
  const fallbackBodyBytes = manifest.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const routes = createHttpRouteResolver<ServedRoute>(
    operations.map(([name, op]) => ({ name, op, http: op.http, query: queryKinds(op) }))
  );
  const transports = httpTransports(hooks.transports, manifest.mcp !== undefined);
  const mcpTransport = transports.mcp;
  /**
   * The transport's operations a caller may run, those its scopes and actor kind admit: what sizes the body
   * it may send, so no one else's large operation widens it.
   */
  const runnableBy = (caller: TokenPrincipal) =>
    operations.filter(
      ([, op]) =>
        operationMatchesScopes(op, caller.scopes) &&
        (!op.actorKinds || op.actorKinds.includes(caller.actorKind))
    );
  const applicationScopes = Object.freeze([
    ...new Set([
      ...operations.flatMap(([, op]) => [...operationScopes(op), ...(op.conditionalScopes ?? [])]),
      ...[...transports.byPath.values()].map((transport) => transport.scope(manifest.namespace)),
    ]),
  ]);
  const ownBearer = servesOwnBearer(manifest.tokens, mcpTransport);
  if (mcpTransport?.path === '/') {
    // An MCP server mounted at the root answers `/` itself.
    paths.reserved.delete('/');
  }
  const composed = composition(paths, routes, transports, hooks);

  let document: Record<string, unknown> | undefined;
  /** The origin's OpenAPI document, built once on first use. */
  const contract = () => {
    document ??= createOpenApi(
      paths.base ? { ...manifest, origin: `${manifest.origin}${paths.base}` } : manifest
    );
    return document;
  };
  /** The document's JSON and YAML texts, each serialized once on first use. */
  const texts: { json?: string; yaml?: string } = {};
  /** The origin's OpenAPI document as the text one of its URLs serves. */
  const contractText = (format: 'json' | 'yaml') =>
    (texts[format] ??= format === 'json' ? JSON.stringify(contract()) : stringify(contract()));
  /** The default RFC 9728 protected-resource metadata: the public scopes the origin serves. */
  const metadata = () => ({
    resource: tokenAudiences(manifest.tokens)[0],
    resource_name: manifest.title,
    authorization_servers: [tokenIssuer(manifest.tokens)],
    bearer_methods_supported: ['header'],
    scopes_supported: [
      ...new Set([
        ...operations
          .filter(([, op]) => isPublicOperation(op) && (op.http || (op.mcp && mcpTransport)))
          .flatMap(([, op]) => operationScopes(op)),
        ...[...transports.byPath.values()].map((transport) => transport.scope(manifest.namespace)),
      ]),
    ],
    resource_documentation: `${manifest.origin}${paths.mount('/openapi.json')}`,
  });
  /** The failure envelope, with its status, its challenge and its Retry-After. */
  function failure(
    value: Failure,
    requestId: string,
    context: TokenResolutionContext<E>,
    suppliedHeaders?: HeadersInit
  ) {
    const error = manifest.errors.validate(value);
    const headers = new Headers(suppliedHeaders);
    headers.set('content-type', 'application/json');
    headers.set('cache-control', 'private, no-store');
    headers.set('x-content-type-options', 'nosniff');
    headers.set('x-request-id', requestId);
    if (error.code === 'UNAUTHORIZED' && !headers.has('www-authenticate')) {
      const metadataUrl = challengeMetadataUrl(context);
      headers.set(
        'www-authenticate',
        ownBearer || metadataUrl === null ? 'Bearer' : `Bearer resource_metadata="${metadataUrl}"`
      );
    }
    const retry = manifest.errors.retryAfter(error.code);
    if (retry) {
      headers.set(
        'retry-after',
        String(error.code === 'RATE_LIMITED' ? (manifest.rateLimit?.retryAfter ?? retry) : retry)
      );
    }
    return Response.json(
      { success: false, data: null, error, metadata: { requestId } },
      { status: manifest.errors.status(error.code), headers }
    );
  }
  /** The protected-resource metadata a 401 points at, or null when there is none to point at. */
  function challengeMetadataUrl(context: TokenResolutionContext<E>): string | null {
    const configured = manifest.tokens.resourceMetadataUrl;
    if (typeof configured === 'function') {
      return configured(context);
    }
    if (configured !== undefined) {
      return configured;
    }
    if (manifest.tokens.resources !== undefined && paths.resources.size === 0) {
      return null;
    }
    return `${manifest.origin}${paths.mount('/.well-known/oauth-protected-resource')}`;
  }
  /** The application's own GET documents: its index, its OpenAPI and its discovery metadata. */
  function nativeDocument(nativePath: string | null, reject: (error: Failure) => Response): Response | null {
    switch (nativePath) {
      case '/': {
        return Response.json({
          name: manifest.title,
          openapi: paths.mount('/openapi.json'),
          ...(manifest.mcp && mcpTransport ? { mcp: mcpTransport.path } : {}),
        });
      }
      case '/openapi.json': {
        return new Response(contractText('json'), { headers: { 'content-type': 'application/json' } });
      }
      case '/openapi.yaml':
      case '/openapi.yml': {
        return new Response(contractText('yaml'), {
          headers: { 'content-type': 'application/yaml; charset=utf-8' },
        });
      }
      case '/.well-known/oauth-protected-resource':
      case '/.well-known/oauth-protected-resource/mcp': {
        if (ownBearer || manifest.tokens.resources !== undefined) {
          return reject(standardErrors.notFound.create());
        }
        return Response.json(metadata(), { headers: { 'access-control-allow-origin': '*' } });
      }
      default: {
        return null;
      }
    }
  }
  /** Whether the rate limit binding still admits this caller; the key is a digest of who calls. */
  async function withinRateLimit(env: E, caller: TokenPrincipal): Promise<boolean> {
    if (!manifest.rateLimit) {
      return true;
    }
    const binding = env[manifest.rateLimit.binding] as {
      limit: (input: { key: string }) => Promise<{ success: boolean }>;
    };
    const { success } = await binding.limit({
      key: await sha256Hex(`${caller.organizationId}:${caller.actorId}`),
    });
    return success;
  }

  /**
   * Answers one request: dispatches it, turns an unexpected error into INTERNAL_ERROR, and sets the request
   * id, cache and timing headers on every response.
   */
  async function handle(incoming: Request, env: E, background?: BackgroundContext): Promise<Response> {
    const started = performance.now();
    const requestId = crypto.randomUUID();
    let principal: Principal | null = null;
    let operation: string | null = null;
    let surface: 'http' | 'mcp' = 'http';
    let plain = false;
    let requestEnv = env;
    const context: RouteContext = {
      requestId,
      fail: (error, headers) => failure(error, requestId, resolutionContext(), headers),
      waitUntil: (promise) => {
        if (background) {
          background.waitUntil(promise);
        } else {
          void (async () => {
            try {
              await promise;
            } catch (error) {
              reportUnexpected(error, 'route', requestId);
            }
          })();
        }
      },
    };
    /** What a token resolver and a challenge URL see of this request. */
    const resolutionContext = (): TokenResolutionContext<E> => ({
      env: requestEnv,
      request: incoming,
      surface,
      applicationScopes,
      background,
    });
    /** A refusal before execution, observed as a rejected admission. */
    function reject(error: Failure): Response {
      recordAdmission(manifest, requestEnv, background, {
        principal,
        operation,
        surface,
        requestId,
        started,
        errorCode: error.code,
      });
      return failure(error, requestId, resolutionContext());
    }
    /**
     * Routes the request: origin pinning, the `before` hook, plain routes and mounts, liveness and discovery
     * documents, then an operation or a transport, else the fallback or NOT_FOUND.
     */
    async function dispatchNative(): Promise<Response> {
      const url = new URL(incoming.url);
      if (hooks.before) {
        plain = true;
        const response = await hooks.before(incoming, env, context);
        if (response) {
          return response;
        }
        plain = false;
      }
      const route = composed.routes.get(url.pathname) ?? composed.mounted(url.pathname);
      if (route) {
        plain = true;
        return route(incoming, env, context);
      }
      const nativePath = paths.local(url.pathname);
      const resource = paths.resources.get(url.pathname);
      if (url.pathname === paths.health || resource) {
        if (incoming.method !== 'GET') {
          return context.fail(standardErrors.methodNotAllowed.create(), { allow: 'GET' });
        }
        return resource
          ? Response.json(protectedResourceMetadata(resource, env), {
              headers: { 'access-control-allow-origin': '*' },
            })
          : Response.json({ status: 'ok', service: manifest.name, version: manifest.version });
      }
      if (incoming.method === 'GET' && !transports.byPath.has(url.pathname)) {
        const native = nativeDocument(nativePath, reject);
        if (native) {
          return native;
        }
      }
      const operationRoute = routes.match(incoming.method, nativePath ?? '');
      const transport = transports.byPath.get(url.pathname);
      operation = operationRoute?.definition.name ?? null;
      surface = transport ? 'mcp' : 'http';
      if (!operationRoute && !transport) {
        const reserved =
          (paths.base && nativePath !== null) ||
          ownsPrefix('/.well-known', url.pathname) ||
          VERSIONED_PATH.test(url.pathname) ||
          paths.reserved.has(url.pathname) ||
          [...transports.byPath.keys()].some((prefix) => ownsPrefix(prefix, url.pathname));
        if (hooks.fallback && !reserved) {
          plain = true;
          return hooks.fallback(incoming, env, context);
        }
        return reject(standardErrors.notFound.create());
      }
      let invoked = false;
      /**
       * Admits and runs the matched operation or transport with the env `aroundOperation` scoped: token, rate
       * limit, bounded body, then input and execution.
       */
      async function run(scopedEnv: E): Promise<Response> {
        if (invoked) {
          throw new TypeError('An HTTP operation continuation may run only once.');
        }
        invoked = true;
        requestEnv = scopedEnv;
        const result = await authorize(
          incoming,
          operationRoute
            ? operationScopes(operationRoute.definition.op)
            : (transport?.scope(manifest.namespace) ?? ''),
          { env: scopedEnv, request: incoming, surface, applicationScopes, background },
          operationRoute?.definition.op.scopeMatch
        );
        if (!result.ok) {
          return reject(result.error);
        }
        const authenticated = result.value;
        // The verified OAuth access token, for an operation that calls another service as the same caller.
        const accessToken = ownBearer
          ? undefined
          : /^Bearer (\S+)$/i.exec(incoming.headers.get('authorization') ?? '')?.[1];
        const actor: Principal = {
          actorId: authenticated.actorId,
          actorKind: authenticated.actorKind,
          organizationId: authenticated.organizationId,
          requestId,
        };
        principal = actor;
        if (!(await withinRateLimit(scopedEnv, authenticated))) {
          return reject(standardErrors.rateLimited.create());
        }
        let request = incoming;
        let bodyText = '';
        const byteOperation = operationRoute?.definition.op.http?.body === 'bytes';
        if (request.body && !byteOperation) {
          const maxBytes = operationRoute
            ? (operationRoute.definition.op.maxBodyBytes ?? fallbackBodyBytes)
            : (transport?.maxBodyBytes?.(runnableBy(authenticated), fallbackBodyBytes) ?? fallbackBodyBytes);
          const body = await readBodyText(request, { maxBytes });
          if (!body.ok) {
            return reject(
              body.error.data.reason === 'too_large'
                ? standardErrors.tooLarge.create()
                : standardErrors.invalidInput.create()
            );
          }
          bodyText = body.value;
          request = new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: bodyText,
            signal: request.signal,
          });
        }
        /** How many requests this one has carried; admission rate limited the first with the request. */
        let carried = 0;
        /**
         * Counts one more request this one carries. A transport may carry several (a JSON-RPC batch over
         * MCP): every one after the first passes the rate limit as a request of its own would.
         */
        async function admitRequest(): Promise<boolean> {
          carried += 1;
          return carried === 1 || (await withinRateLimit(scopedEnv, authenticated));
        }
        /**
         * Runs one operation through the shared execution path as the admitted caller, and records the call.
         */
        async function invoke(name: string, op: OperationShape, input: unknown) {
          if (
            transport &&
            !operations.some(([selectedName, selected]) => selectedName === name && selected === op)
          ) {
            return { ok: false as const, error: standardErrors.notFound.create() };
          }
          const admissionStarted = performance.now();
          if (!(await admitRequest())) {
            const error = standardErrors.rateLimited.create();
            recordAdmission(manifest, scopedEnv, background, {
              principal: actor,
              operation: name,
              surface,
              requestId,
              started: admissionStarted,
              errorCode: error.code,
            });
            return { ok: false as const, error };
          }
          if (telemetryEnabled(manifest.telemetry, scopedEnv)) {
            hooks.annotate?.(name, requestId);
          }
          const invocationStarted = performance.now();
          const output = await executeOperation(
            manifest,
            op,
            scopedEnv,
            actor,
            input,
            authenticated.client
              ? {
                  surface: transport ? 'mcp' : 'http',
                  scopes: authenticated.scopes,
                  client: authenticated.client,
                  ...(accessToken ? { token: accessToken } : {}),
                }
              : undefined,
            background,
            byteOperation ? binaryBody(incoming, op.maxBodyBytes ?? fallbackBodyBytes) : undefined
          );
          recordExecution(manifest, scopedEnv, background, {
            principal: actor,
            operation: name,
            surface: transport ? 'mcp' : 'http',
            started: invocationStarted,
            result: output,
          });
          return output;
        }
        if (transport) {
          return transport.handle({
            request,
            requestId,
            authenticated,
            application: manifest,
            operations,
            contract,
            contractText,
            url: (path) => `${manifest.origin}${paths.mount(path)}`,
            invoke,
            admitRequest,
            bodyBytes: new TextEncoder().encode(bodyText).byteLength,
            bodyLimit: (op) => op.maxBodyBytes ?? fallbackBodyBytes,
          });
        }
        if (!operationRoute) {
          return reject(standardErrors.notFound.create());
        }
        const input = operationInput(operationRoute, incoming, url, bodyText);
        if (!input.ok) {
          return reject(input.error);
        }
        const output = await invoke(
          operationRoute.definition.name,
          operationRoute.definition.op,
          input.value
        );
        if (!output.ok) {
          return failure(output.error, requestId, resolutionContext());
        }
        const exposure = operationRoute.definition.op.http;
        if (exposure?.response === 'attachment') {
          return attachmentResponse(output.value as Attachment, exposure.successStatus ?? 200);
        }
        return Response.json(
          { success: true, data: output.value, error: null, metadata: { requestId } },
          { status: exposure?.successStatus ?? 200 }
        );
      }
      return operationRoute && hooks.aroundOperation
        ? hooks.aroundOperation(
            incoming,
            env,
            {
              name: operationRoute.definition.name,
              effect: operationRoute.definition.op.effect,
            },
            run
          )
        : run(env);
    }
    let response: Response;
    try {
      if (hooks.origins && !hooks.origins.includes(new URL(incoming.url).origin)) {
        response = reject(standardErrors.notFound.create());
      } else {
        const dispatch = async (index: number): Promise<Response> => {
          const middleware = hooks.middleware?.[index];
          if (!middleware) {
            return dispatchNative();
          }
          let invoked = false;
          let active = true;
          const requestView = new Request(incoming.url, {
            method: incoming.method,
            headers: new Headers(incoming.headers),
            signal: incoming.signal,
          });
          try {
            return await middleware(requestView, env, context, () => {
              if (invoked || !active) {
                throw new TypeError(
                  'An HTTP middleware continuation may run only once before its wrapper settles.'
                );
              }
              invoked = true;
              return dispatch(index + 1);
            });
          } finally {
            active = false;
          }
        };
        response = await dispatch(0);
      }
    } catch (error) {
      reportUnexpected(error, plain ? 'route' : 'http', requestId);
      response = plain
        ? failure(standardErrors.internal.create(), requestId, resolutionContext())
        : reject(standardErrors.internal.create());
    }
    // Workers' 101 response carries its socket outside standard ResponseInit; rebuilding it loses the upgrade.
    if (response.status === 101) {
      return response;
    }
    const headers = new Headers(response.headers);
    headers.set('x-request-id', requestId);
    // A plain route may choose its own caching (a signed file link); everything else is never cached.
    if (!(plain && headers.has('cache-control'))) {
      headers.set('cache-control', 'private, no-store');
    }
    headers.set('x-content-type-options', 'nosniff');
    headers.set('server-timing', `total;dur=${(performance.now() - started).toFixed(1)}`);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  return (request: Request, env: E, background?: BackgroundContext) =>
    withTelemetry(manifest.telemetry, env, () => handle(request, env, background));
}

/**
 * An operation's input from its HTTP request: a byte operation's query and header metadata, a GET's
 * typed query, a DELETE's absent body or a JSON body, with the path parameters added. A path
 * parameter may come only from the path, never also from the query or the body.
 */
function operationInput(
  route: HttpRouteMatch<ServedRoute>,
  request: Request,
  url: URL,
  bodyText: string
): Result<unknown, Failure> {
  const { op, query } = route.definition;
  let input: unknown;
  if (op.http?.body === 'bytes') {
    const fields = [...url.searchParams.keys()];
    if (new Set(fields).size !== fields.length) {
      return err(standardErrors.invalidInput.create());
    }
    const inputMetadata: Record<string, string> = Object.fromEntries(url.searchParams);
    for (const [field, header] of Object.entries(op.http.headers ?? {})) {
      if (url.searchParams.has(field)) {
        return err(standardErrors.invalidInput.create());
      }
      const value = request.headers.get(header);
      if (value !== null) {
        inputMetadata[field] = value;
      }
    }
    input = inputMetadata;
  } else if (request.method === 'GET') {
    // Each declared field as its kind; no nested-object parsing or duplicate-key ambiguity.
    const fields = queryInput(query, url.searchParams);
    if (!fields) {
      return err(standardErrors.invalidInput.create());
    }
    input = fields;
  } else if (request.method === 'DELETE' && bodyText === '' && !request.headers.has('content-type')) {
    // A DELETE names its target in the path: an absent body is the empty input, not a media type.
    input = {};
  } else {
    if (mediaType(request.headers.get('content-type')) !== 'application/json') {
      return err(standardErrors.unsupportedMedia.create());
    }
    try {
      input = JSON.parse(bodyText);
    } catch {
      return err(standardErrors.invalidInput.create());
    }
  }
  const { parameters } = route;
  if (Object.keys(parameters).some((name) => url.searchParams.has(name))) {
    return err(standardErrors.invalidInput.create());
  }
  if (Object.keys(parameters).length === 0) {
    return ok(input);
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return err(standardErrors.invalidInput.create());
  }
  const body = input;
  if (Object.keys(parameters).some((name) => Object.hasOwn(body, name))) {
    return err(standardErrors.invalidInput.create());
  }
  return ok({ ...body, ...parameters });
}
