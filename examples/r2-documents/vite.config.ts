/**
 * The only configuration: the documents service, its Worker and its R2 bucket, which the first deployment
 * creates.
 */
import { maximus } from '@arbol-ai/maximus/vite';
import { bindings } from 'cf/config';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [
    maximus({
      name: 'example-r2-documents',
      namespace: 'documents',
      title: 'Documents',
      // The Worker's workers.dev URL in the account it deploys to.
      origin: `https://example-r2-documents.${process.env.WORKERS_SUBDOMAIN ?? 'example'}.workers.dev`,
      tokens: { issuer: 'https://auth.example.com/' },
      compatibilityDate: '2026-10-26',
      env: { DOCUMENTS: bindings.r2({ name: 'maximus-example-documents' }) },
    }),
  ],
});
