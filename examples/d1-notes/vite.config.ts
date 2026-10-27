/**
 * The only configuration: the notes service, its Worker and its D1 database. A deployment binds the database
 * whose id NOTES_DB_ID holds (`cf d1 create maximus-example-notes` prints it); without one, vp dev and
 * vp preview keep a local database under .cloudflare/state, with the fixed id `bun run migrate:local` migrates.
 */
import { maximus } from '@arbol-ai/vite-plugin';
import { bindings } from 'cf/config';
import { defineConfig } from 'vite-plus';

/** The id of the local database, which no Cloudflare account holds: a build bound to it never deploys. */
const LOCAL_DATABASE = '00000000-0000-4000-8000-00000000d1d1';

export default defineConfig({
  plugins: [
    maximus({
      name: 'example-d1-notes',
      namespace: 'notes',
      title: 'Notes',
      // The Worker's workers.dev URL in the account it deploys to.
      origin: `https://example-d1-notes.${process.env.WORKERS_SUBDOMAIN ?? 'example'}.workers.dev`,
      // OAuth access tokens from your authorization server (replace it with yours); `vp dev` also accepts
      // the development token in .dev.vars from localhost.
      tokens: { issuer: 'https://auth.example.com/' },
      compatibilityDate: '2026-10-26',
      env: {
        NOTES_DB: bindings.d1({
          name: 'maximus-example-notes',
          id: process.env.NOTES_DB_ID ?? LOCAL_DATABASE,
        }),
      },
    }),
  ],
});
