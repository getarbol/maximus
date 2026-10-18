/**
 * How callers authenticate: OAuth access tokens, plus a development token that only localhost accepts.
 */
import type { TokenPolicy } from '@arbol-ai/maximus';

/**
 * OAuth access tokens from your authorization server (replace the issuer and the audience with your own),
 * and, from localhost only, the long DEVELOPMENT_TOKEN that `.dev.vars` sets for `cf dev`, as a
 * developer holding every scope the application declares. Never set DEVELOPMENT_TOKEN on a deployed Worker.
 */
export const tokens: TokenPolicy = {
  issuer: 'https://auth.example.com/',
  audience: 'https://orders.example.com',
  development: { binding: 'DEVELOPMENT_TOKEN' },
};
