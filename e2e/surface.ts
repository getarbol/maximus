/**
 * What any caller of an example's Worker sees, signed in or not: its health, its OpenAPI document, and a
 * call without a token refused with a challenge that points at the OAuth metadata the Worker publishes.
 */
import { describe, expect, it } from 'vite-plus/test';

import { call, required, service } from './services.ts';
import type { ExampleName } from './services.ts';

/** The issuer every example names in tokens.issuer. */
const ISSUER = 'https://auth.example.com/';

/** Registers the checks for the example's Worker: one route of its API, and whether it serves MCP. */
export function publicSurface(
  name: ExampleName,
  route: { method: string; path: string; published?: boolean; mcp?: boolean }
): void {
  describe.runIf(service(name))(`${name}: what any caller sees`, () => {
    it('reports its health', async () => {
      const health = await call(required(name), '/health', { signedIn: false });
      expect(health.status).toBe(200);
    });

    it('publishes its OpenAPI document', async () => {
      const response = await call(required(name), '/api/openapi.json', { signedIn: false });
      const document = (await response.json()) as { openapi: string; paths: Record<string, unknown> };
      expect(document.openapi).toMatch(/^3\.1\./);
      // An internal route stays out of it.
      expect(Object.keys(document.paths).includes(route.path)).toBe(route.published ?? true);
    });

    it('refuses a call without a token, pointing at its OAuth metadata', async () => {
      const worker = required(name);
      const refused = await call(worker, `/api${route.path}`, { method: route.method, signedIn: false });
      expect(refused.status).toBe(401);
      const metadata = /resource_metadata="([^"]+)"/.exec(refused.headers.get('www-authenticate') ?? '')?.[1];
      // The metadata names the deployed origin; the Worker under test answers its path.
      const published = await call(worker, new URL(metadata ?? '/missing', worker.url).pathname, {
        signedIn: false,
      });
      expect(await published.json()).toMatchObject({ authorization_servers: [ISSUER] });
    });

    it.runIf(route.mcp)('refuses an MCP client without a token', async () => {
      const refused = await call(required(name), '/mcp', {
        method: 'POST',
        signedIn: false,
        json: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      });
      expect(refused.status).toBe(401);
    });
  });
}
