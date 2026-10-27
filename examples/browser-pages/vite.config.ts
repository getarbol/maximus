/**
 * The only configuration: the pages service, its Worker and its Browser Rendering binding. Every browser
 * session it starts reaches only the hosts src/hosts.ts allows.
 */
import { maximus } from '@arbol-ai/maximus/vite';
import { bindings } from 'cf/config';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [
    maximus({
      name: 'example-browser-pages',
      namespace: 'pages',
      title: 'Pages',
      description:
        'Reads public web pages at the hosts it allows, as Markdown, and captures them as PNG images.',
      groups: {
        Pages: 'Public web pages, read or captured as a browser renders them.',
      },
      // The Worker's workers.dev URL in the account it deploys to.
      origin: `https://example-browser-pages.${process.env.WORKERS_SUBDOMAIN ?? 'example'}.workers.dev`,
      tokens: { issuer: 'https://auth.example.com/' },
      compatibilityDate: '2026-10-26',
      env: { BROWSER: bindings.browser({ dev: { remote: true } }) },
    }),
  ],
});
