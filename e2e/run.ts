/**
 * Runs the end-to-end suites against running Workers: `node e2e/run.ts` starts every example under `vp dev`,
 * runs the suites and stops them again; with `E2E_TARGET=remote` it runs them against the Workers deployed to
 * the account's workers.dev subdomain, `WORKERS_SUBDOMAIN`, which accept no development token. Exits with the
 * suites' status.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { deployedServices, startServices } from './servers.ts';

/** The services, and how to stop what this run started. */
async function services() {
  if (process.env.E2E_TARGET !== 'remote') {
    return await startServices();
  }
  const subdomain = process.env.WORKERS_SUBDOMAIN;
  if (!subdomain) {
    throw new Error("Set WORKERS_SUBDOMAIN to the account's workers.dev subdomain.");
  }
  return { services: deployedServices(subdomain), stop: async () => {} };
}

const running = await services();
try {
  const suites = spawn('npx', ['vp', 'test', 'run', '--project', 'e2e', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, E2E_SERVICES: JSON.stringify(running.services) },
  });
  const [code] = (await once(suites, 'exit')) as [number | null];
  process.exitCode = code ?? 1;
} finally {
  await running.stop();
}
