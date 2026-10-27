/**
 * The example Workers the end-to-end suites call, started for a local run: each under `vp dev` on its own
 * port, with its D1 migrations applied and a development token of its own. An example whose binding reaches
 * the account's own service starts only when Cloudflare credentials are present. Each server's output is in
 * .e2e/<example>.log.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { EXAMPLES } from './examples.ts';
import type { Example, ExampleName, Service } from './examples.ts';

/** The repository's examples. */
const ROOT = join(import.meta.dirname, '..');
/** Where each server's output goes. */
const LOGS = join(ROOT, '.e2e');
/** How long a server may take to answer its health check, in milliseconds. */
const STARTUP = 120_000;

/** A server this run started, and the development token file it wrote, if it wrote one. */
interface Started {
  child: ChildProcess;
  written?: string;
}

/** Runs a command in a directory and resolves once it succeeds. */
async function run(command: string, args: readonly string[], cwd: string, log: string): Promise<void> {
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = createWriteStream(log, { flags: 'a' });
  child.stdout.pipe(output);
  child.stderr.pipe(output);
  const [code] = (await once(child, 'exit')) as [number | null];
  if (code !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd}; see ${log}.`);
  }
}

/**
 * The development token in the example's .dev.vars. A developer's own file is read and kept; without one, a
 * new token is written, 0600, and removed again after the run.
 */
function developmentToken(directory: string): { token: string; written?: string } {
  const file = join(directory, '.dev.vars');
  if (existsSync(file)) {
    const token = /^DEVELOPMENT_TOKEN=(.+)$/m.exec(readFileSync(file, 'utf-8'))?.[1]?.trim();
    if (!token) {
      throw new Error(`${file} declares no DEVELOPMENT_TOKEN.`);
    }
    return { token };
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(file, `DEVELOPMENT_TOKEN=${token}\n`, { mode: 0o600 });
  return { token, written: file };
}

/** Resolves once the server answers its health check, and fails when it exits or takes too long. */
async function healthy(url: string, child: ChildProcess, log: string): Promise<void> {
  const deadline = Date.now() + STARTUP;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`The server for ${url} exited with ${child.exitCode}; see ${log}.`);
    }
    try {
      // A server still preparing its dependencies may hold a request: ask again rather than wait on it.
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await sleep(500);
  }
  throw new Error(`The server for ${url} did not answer within ${STARTUP / 1000} seconds; see ${log}.`);
}

/** Whether a server already answers on the port: it would answer in place of the one about to start. */
async function listening(port: number): Promise<boolean> {
  try {
    await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch (error) {
    // Refused: nothing listens. A timeout: something holds the port without answering.
    return !(error instanceof TypeError);
  }
}

/** Starts one example under `vp dev`, its migrations applied first, and resolves once it is healthy. */
async function start(
  name: ExampleName,
  example: Example,
  started: Started[]
): Promise<[ExampleName, Service]> {
  if (await listening(example.port)) {
    throw new Error(
      `Port ${example.port} already answers: stop the server there before the ${name} suite starts.`
    );
  }
  const directory = join(ROOT, 'examples', example.directory);
  const log = join(LOGS, `${name}.log`);
  writeFileSync(log, '');
  const { token, written } = developmentToken(directory);
  if (existsSync(join(directory, 'migrations'))) {
    await run('bun', ['run', 'migrate:local'], directory, log);
  }
  // Its own process group, so stopping it stops workerd with it.
  const child = spawn('bunx', ['vp', 'dev', '--port', String(example.port), '--strictPort'], {
    cwd: directory,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CF_SEND_TELEMETRY: 'false' },
  });
  started.push({ child, written });
  const output = createWriteStream(log, { flags: 'a' });
  child.stdout?.pipe(output);
  child.stderr?.pipe(output);
  const url = `http://localhost:${example.port}`;
  await healthy(url, child, log);
  return [name, { url, token }];
}

/** Stops every server this run started, and removes the token files it wrote. */
async function stop(started: readonly Started[]): Promise<void> {
  await Promise.all(
    started.map(async ({ child, written }) => {
      if (child.pid !== undefined && child.exitCode === null) {
        const exited = once(child, 'exit');
        process.kill(-child.pid, 'SIGTERM');
        await exited;
      }
      if (written) {
        rmSync(written, { force: true });
      }
    })
  );
}

/** The deployed Worker of each example, at the account's workers.dev subdomain. */
export function deployedServices(subdomain: string): Partial<Record<ExampleName, Service>> {
  return Object.fromEntries(
    Object.entries(EXAMPLES).map(([name, { worker }]) => [
      name,
      { url: `https://${worker}.${subdomain}.workers.dev`, deployed: true },
    ])
  );
}

/** Starts every example this run can, and answers each one's Worker and how to stop them all. */
export async function startServices(): Promise<{
  services: Partial<Record<ExampleName, Service>>;
  stop: () => Promise<void>;
}> {
  mkdirSync(LOGS, { recursive: true });
  const credentials = Boolean(process.env.CLOUDFLARE_API_TOKEN);
  const started: Started[] = [];
  const services: [ExampleName, Service][] = [];
  try {
    // One at a time: servers starting together race for the same debugger port, and the loser exits.
    for (const [name, example] of Object.entries(EXAMPLES) as [ExampleName, Example][]) {
      if (credentials || !example.remote) {
        services.push(await start(name, example, started));
      }
    }
    return { services: Object.fromEntries(services), stop: () => stop(started) };
  } catch (error) {
    await stop(started);
    throw error;
  }
}
