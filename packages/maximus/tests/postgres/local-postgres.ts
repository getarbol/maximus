/**
 * Vitest global setup for the Postgres integration tests: starts a disposable `postgres` container in
 * Docker and provides its connection URL.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type { TestProject } from 'vite-plus/test/node';

declare module 'vitest' {
  export interface ProvidedContext {
    postgresUrl: string;
  }
}

/** Fixture cannot accept environment URLs, download images, mount host data or bind a public port. */
export default async function setup(project: TestProject) {
  const name = `maximus-postgres-${randomUUID()}`;
  const docker = (...args: string[]) =>
    execFileSync('docker', args, { encoding: 'utf-8', timeout: 10_000 }).trim();
  docker(
    'run',
    '--rm',
    '--detach',
    '--pull=never',
    '--name',
    name,
    '--tmpfs',
    '/var/lib/postgresql',
    '--publish',
    '127.0.0.1::5432',
    '--env',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    'postgres:18.6-trixie'
  );
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        docker('exec', name, 'pg_isready', '-U', 'postgres');
        ready = true;
        break;
      } catch {
        await delay(250);
      }
    }
    if (!ready) {
      throw new Error('Disposable local Postgres did not become ready.');
    }
    const port = docker('port', name, '5432/tcp');
    if (!/^127\.0\.0\.1:[0-9]+$/.test(port)) {
      throw new Error('Fixture refused non-loopback port.');
    }
    project.provide('postgresUrl', `postgresql://postgres@${port}/postgres`);
  } catch (error) {
    docker('stop', name);
    throw error;
  }
  return () => {
    docker('stop', name);
  };
}
