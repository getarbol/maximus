/**
 * Where a Worker may send a request for someone it does not control, such as a server an organization
 * registered. A Worker cannot resolve a name before it fetches it, so the rules hold on the URL itself.
 */

/**
 * Top-level names reserved for special use or private networks (RFC 2606, 6761, 6762, 7686, 8375 and 9476),
 * and the ones internal networks use.
 */
const PRIVATE_TOP_LEVEL_NAMES: ReadonlySet<string> = new Set([
  'alt',
  'arpa',
  'cloudflare',
  'corp',
  'example',
  'home',
  'internal',
  'intranet',
  'invalid',
  'lan',
  'local',
  'localdomain',
  'localhost',
  'onion',
  'private',
  'test',
]);
/**
 * Cloudflare's own domains and Arbol's, subdomains included: Arbol's services are reached through the Gateway
 * and native RPC, and neither ever stands for someone else's server.
 */
const PLATFORM_DOMAINS = [
  'cloudflare.com',
  'cloudflareaccess.com',
  'cloudflareclient.com',
  'cloudflare-dns.com',
  'cloudflare-gateway.com',
  'getarbol.app',
  'getarbol.com',
];
/**
 * A DNS name of two labels or more: letters, digits and inner hyphens, at most 63 characters a label and 253
 * in all, under a top-level name of letters. An IP literal is none.
 */
const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * The URL, when a Worker may send a request there for someone it does not control: https on its default port,
 * with no credentials or fragment, to a public DNS name; never an IP literal, a special-use or private-network
 * name, nor Cloudflare's or Arbol's own hosts. Undefined for anything else. Send the request with
 * `redirect: 'manual'` and refuse a `3xx`, so no redirect takes it elsewhere.
 */
export function publicDestination(value: string | URL): URL | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const host = url.hostname;
  const topLevelName = host.slice(host.lastIndexOf('.') + 1);
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    !DNS_NAME.test(host) ||
    PRIVATE_TOP_LEVEL_NAMES.has(topLevelName) ||
    PLATFORM_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
  ) {
    return undefined;
  }
  return url;
}
