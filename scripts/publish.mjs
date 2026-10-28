/**
 * Publishes the packed tarball of @arbol-ai/maximus to npm, with provenance, a prerelease under its own
 * dist-tag. The publish workflow runs it after the release checks.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Where the tarball is packed, removed at the end. */
const directory = mkdtempSync(join(tmpdir(), 'maximus-release-'));
try {
  const cwd = resolve('packages/maximus');
  const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
  // A prerelease (4.0.0-next.0) goes out under its own tag (next), so `latest` never moves to it.
  const prerelease = /^\d+\.\d+\.\d+-([a-z]+)/.exec(manifest.version)?.[1];
  execFileSync('bun', ['pm', 'pack', '--destination', directory], { cwd, stdio: 'pipe' });
  execFileSync(
    'npm',
    [
      'publish',
      join(directory, `arbol-ai-maximus-${manifest.version}.tgz`),
      '--ignore-scripts',
      '--registry=https://registry.npmjs.org/',
      '--access=public',
      '--provenance',
      '--tag',
      prerelease ?? 'legacy-7',
    ],
    { stdio: 'inherit' }
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
