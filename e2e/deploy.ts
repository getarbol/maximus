/**
 * Deploys every example to the Cloudflare account that CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID name,
 * where `E2E_TARGET=remote bun run test:e2e` then calls them. Pricing deploys before orders, whose binding
 * names it, and the notes database is migrated before the Worker that reads it. WORKERS_SUBDOMAIN names the
 * account's workers.dev subdomain; NOTES_DB_ID names the notes database, which
 * `cf d1 create maximus-example-notes` created once.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { EXAMPLES } from './examples.ts';

// The variables a deployment needs, each named in the error when it is missing.
for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'WORKERS_SUBDOMAIN', 'NOTES_DB_ID']) {
  if (!process.env[name]) {
    throw new Error(`Set ${name} to deploy the examples.`);
  }
}

/** Runs a command in an example's directory, showing its output, and fails with it. */
function run(directory: string, command: string, args: readonly string[]): void {
  execFileSync(command, args, {
    cwd: directory,
    stdio: 'inherit',
    env: { ...process.env, CF_SEND_TELEMETRY: 'false' },
  });
}

/** What a version records of the commit it was built from, when CI names one. */
const tag = process.env.GITHUB_SHA ? ['--tag', process.env.GITHUB_SHA.slice(0, 12)] : [];

for (const { directory } of Object.values(EXAMPLES)) {
  const root = join(import.meta.dirname, '../examples', directory);
  if (directory === 'd1-notes') {
    run(root, 'bun', ['run', 'migrate']);
  }
  run(root, 'bun', ['run', 'build']);
  run(root, 'bunx', ['cf', 'deploy', '--prebuilt', '--mode', 'production', ...tag]);
}
