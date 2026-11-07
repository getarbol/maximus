/**
 * Where a Worker may send a request for someone it does not control: https on its default port to a public
 * DNS name, never an IP literal, credentials, a fragment, a special-use or private-network name, nor
 * Cloudflare's or Arbol's own hosts.
 */
import { expect, it } from 'vite-plus/test';

import { publicDestination } from '../../src/body.ts';

it('admits https to a public name on the default port, as the URL it parsed', () => {
  for (const [value, href] of [
    ['https://clinic-server.com/mcp', 'https://clinic-server.com/mcp'],
    ['https://api.clinica.com.co:443/v1/tools?scope=all', 'https://api.clinica.com.co/v1/tools?scope=all'],
    ['HTTPS://API.Clinic.COM/', 'https://api.clinic.com/'],
    ['https://clínica.co/', 'https://xn--clnica-4va.co/'],
    // Arbol's names inside someone else's are someone else's.
    ['https://getarbol.com.clinic.co/', 'https://getarbol.com.clinic.co/'],
    ['https://notgetarbol.com/', 'https://notgetarbol.com/'],
  ]) {
    expect(publicDestination(value ?? '')?.href, value).toBe(href);
  }
  const url = new URL('https://clinic-server.com/mcp');
  const admitted = publicDestination(url);
  expect(admitted?.href).toBe(url.href);
  // A copy: changing the caller's URL afterwards changes nothing it was given.
  expect(admitted).not.toBe(url);
});

it('refuses another scheme or port, credentials, a fragment and anything that is no URL', () => {
  for (const value of [
    '',
    'not a url',
    'http://clinic-server.com/',
    'wss://clinic-server.com/',
    'https://clinic-server.com:8443/',
    'https://user:secret@clinic-server.com/',
    'https://user@clinic-server.com/',
    'https://clinic-server.com/#token',
  ]) {
    expect(publicDestination(value), value).toBeUndefined();
  }
});

it('refuses IP literals, in every spelling a URL parser reads as one', () => {
  for (const value of [
    'https://203.0.113.7/',
    'https://127.0.0.1/',
    'https://2130706433/',
    'https://0x7f.1/',
    'https://[::1]/',
    'https://[2001:db8::1]/',
  ]) {
    expect(publicDestination(value), value).toBeUndefined();
  }
});

it('refuses a name that is not public DNS: one label, special-use and private names, malformed labels', () => {
  for (const value of [
    'https://intranet/',
    'https://localhost/',
    'https://api.localhost/',
    'https://svc.cluster.local/',
    'https://metadata.google.internal/',
    'https://printer.lan/',
    'https://nas.home/',
    'https://erp.corp/',
    'https://vault.private/',
    'https://portal.intranet/',
    'https://box.localdomain/',
    'https://api.test/',
    'https://www.example/',
    'https://site.invalid/',
    'https://hidden.onion/',
    'https://name.alt/',
    'https://1.0.0.127.in-addr.arpa/',
    'https://worker.cloudflare/',
    'https://clinic-server.com./',
    'https://clinic_server.com/',
    'https://-clinic.com/',
    `https://${'a'.repeat(64)}.com/`,
    'https://server.123/',
    'https://сервер.рф/',
  ]) {
    expect(publicDestination(value), value).toBeUndefined();
  }
});

it("refuses Cloudflare's and Arbol's own hosts and their subdomains", () => {
  for (const value of [
    'https://api.cloudflare.com/client/v4',
    'https://cloudflare-dns.com/dns-query',
    'https://team.cloudflareaccess.com/',
    'https://zero-trust.cloudflareclient.com/',
    'https://gateway.cloudflare-gateway.com/',
    'https://getarbol.com/',
    'https://api.getarbol.com/v1/sura',
    'https://raiz.getarbol.com/api',
    'https://getarbol.app/',
    'https://sura.getarbol.app/v1/patients',
    'https://deep.visoft.getarbol.app/',
  ]) {
    expect(publicDestination(value), value).toBeUndefined();
  }
});
