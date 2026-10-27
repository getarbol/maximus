/**
 * The example Workers the end-to-end suites call, and how each suite reaches its own: by its origin, and by
 * the development token `vp dev` accepts when it runs locally. A deployed Worker accepts no development
 * token, so against one the suites check what any caller sees.
 */
import type { ExampleName, Service } from './examples.ts';

export type { ExampleName, Service } from './examples.ts';

/** Each example's Worker, as `e2e/run.ts` hands them to the suites. */
const SERVICES: Partial<Record<ExampleName, Service>> = (() => {
  const handed = process.env.E2E_SERVICES;
  if (!handed) {
    throw new Error('The end-to-end suites call running Workers: run them with `bun run test:e2e`.');
  }
  return JSON.parse(handed) as Partial<Record<ExampleName, Service>>;
})();

/** The example's Worker, or undefined when this run could not start it. */
export function service(name: ExampleName): Service | undefined {
  return SERVICES[name];
}

/** The example's Worker, which the suite asking for it requires. */
export function required(name: ExampleName): Service {
  const found = service(name);
  if (!found) {
    throw new Error(`This run has no ${name} Worker.`);
  }
  return found;
}

/** Calls the Worker: a path below its origin, with its development token when it has one and `signedIn`. */
export function call(
  worker: Service,
  path: string,
  init: RequestInit & { signedIn?: boolean; json?: unknown } = {}
): Promise<Response> {
  const { signedIn = true, json, ...request } = init;
  const headers = new Headers(request.headers);
  if (signedIn && worker.token) {
    headers.set('authorization', `Bearer ${worker.token}`);
  }
  if (json !== undefined) {
    headers.set('content-type', 'application/json');
  }
  return fetch(`${worker.url}${path}`, {
    ...request,
    headers,
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });
}

/** The data of a successful call, failing the test with the answer otherwise. */
export async function data<T>(response: Response | Promise<Response>): Promise<T> {
  const answered = await response;
  const envelope = (await answered.json()) as { success: boolean; data: T; error: unknown };
  if (!envelope.success) {
    throw new Error(`${answered.status}: ${JSON.stringify(envelope.error)}`);
  }
  return envelope.data;
}

/** Calls an MCP method on the Worker and answers its result. */
export async function mcp(
  worker: Service,
  method: string,
  params: object = {}
): Promise<Record<string, unknown>> {
  const response = await call(worker, '/mcp', {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
    json: { jsonrpc: '2.0', id: 1, method, params },
  });
  const text = await response.text();
  const message = JSON.parse(/data: (\{[^\n]*)/u.exec(text)?.[1] ?? text) as {
    result?: Record<string, unknown>;
  };
  if (!message.result) {
    throw new Error(`${method}: ${text}`);
  }
  return message.result;
}
