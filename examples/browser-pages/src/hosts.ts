/**
 * The hosts the browser may reach. An address is checked against them before Chrome starts, and every
 * request Chrome then makes, redirects, frames, scripts and images included, must match one of the request
 * patterns made from them.
 */

/** Each host exactly, or `*.` and a domain for any of its subdomains (but not the domain itself). */
export const ALLOWED_HOSTS: readonly string[] = [
  'example.com',
  'medlineplus.gov',
  'www.who.int',
  '*.wikipedia.org',
];

/** Whether an allowed host is `*.` and a domain, which allows any of the domain's subdomains. */
function isWildcard(host: string): boolean {
  return host.startsWith('*.');
}

/** Whether the hostname is this allowed host, or one of its subdomains when the host is a wildcard. */
function matchesHost(hostname: string, host: string): boolean {
  if (isWildcard(host)) {
    // `*.wikipedia.org` keeps the leading dot: `wikipedia.org` itself does not end with `.wikipedia.org`.
    return hostname.endsWith(host.slice(1));
  }
  return hostname === host;
}

/** Whether the URL is https, on its default port, without credentials, at an allowed host. */
function isAllowedUrl(url: URL): boolean {
  const hasDefaultPort = url.port === '';
  const hasCredentials = url.username !== '' || url.password !== '';
  const hasAllowedHost = ALLOWED_HOSTS.some((host) => matchesHost(url.hostname, host));
  return url.protocol === 'https:' && hasDefaultPort && !hasCredentials && hasAllowedHost;
}

/**
 * The address as the URL the browser may open: https, on its default port, without credentials, at an allowed
 * host. Undefined for any other.
 */
export function parseAllowedUrl(address: string): URL | undefined {
  const url = URL.parse(address);
  if (!url) {
    return undefined;
  }
  if (!isAllowedUrl(url)) {
    return undefined;
  }
  return url;
}

/** The anchored pattern a request to this host must match: https, then the host, then the path or nothing. */
function requestPattern(host: string): string {
  const domain = host.replace(/^\*\./, '').replaceAll('.', String.raw`\.`);
  const subdomains = isWildcard(host) ? '(?:[a-z0-9-]+\\.)+' : '';
  return `^https://${subdomains}${domain}(?:[/?#]|$)`;
}

/**
 * One anchored pattern per host for Chrome's requests: https, the host and nothing else before the path,
 * so a port, credentials, a longer host or a host hidden in the query never match.
 */
export const ALLOWED_REQUEST_PATTERNS: readonly string[] = ALLOWED_HOSTS.map((host) => requestPattern(host));
