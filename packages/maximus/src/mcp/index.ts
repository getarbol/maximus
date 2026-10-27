/**
 * `@arbol-ai/maximus/mcp`: the MCP transport. It serves the operations that declare `mcp` as tools over
 * Streamable HTTP, through a server the official SDK builds for each request. The SDK loads on the first MCP
 * request, so the Worker's other requests never evaluate it.
 */
import type { HttpTransport } from '../index.ts';

/**
 * The MCP transport, for `createWorker(app, { transports: [mcp()] })`: serves the operations that declare
 * `mcp` as tools over Streamable HTTP at `/mcp` (or `path`), with the OpenAPI document and guides as
 * resources, guides as prompts and skills through the Skills extension. A caller needs `<namespace>:mcp:use`
 * and sees only the tools its scopes and actor kind admit. Each message of a JSON-RPC batch passes the rate
 * limit as a request of its own, and each call is held to its operation's body limit.
 */
export function mcp(options: { path?: string } = {}): HttpTransport {
  return {
    protocol: 'mcp',
    path: options.path ?? '/mcp',
    scope: (namespace) => `${namespace}:mcp:use`,
    // One call carries one operation's input: admit the largest body any of the caller's tools accepts,
    // then hold each call to its own operation's limit, as HTTP does.
    maxBodyBytes: (operations, fallback) =>
      Math.max(fallback, ...operations.flatMap(([, op]) => (op.mcp ? [op.maxBodyBytes ?? fallback] : []))),
    async handle(context) {
      const { handleMcp } = await import('./server.ts');
      return handleMcp(context);
    },
  };
}
