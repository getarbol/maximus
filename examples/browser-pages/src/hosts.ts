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

/** Whether the list names the hostname. */
function allowedHost(hostname: string): boolean {
  return ALLOWED_HOSTS.some((host) =>
    host.startsWith('*.') ? hostname.endsWith(host.slice(1)) : hostname === host
  );
}

/**
 * The address as the URL the browser may open: https, on its default port, without credentials, at an allowed
 * host. Undefined for any other.
 */
export function allowedUrl(address: string): URL | undefined {
  const url = URL.parse(address);
  return url?.protocol === 'https:' &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    allowedHost(url.hostname)
    ? url
    : undefined;
}

/**
 * One anchored pattern per host for Chrome's requests: https, the host and nothing else before the path,
 * so a port, credentials, a longer host or a host hidden in the query never match.
 */
export const ALLOWED_REQUESTS: readonly string[] = ALLOWED_HOSTS.map((host) => {
  const domain = host.replace(/^\*\./, '').replaceAll('.', String.raw`\.`);
  return `^https://${host.startsWith('*.') ? '(?:[a-z0-9-]+\\.)+' : ''}${domain}(?:[/?#]|$)`;
});
