/**
 * Publishes the packed tarballs of @arbol-ai/maximus and create-maximus to npm, with provenance, a prerelease
 * under its own dist-tag. They share one version, and Maximus goes first, since create-maximus requires it.
 * Bun packs them; npm publishes them, since npm's CLI alone exchanges the workflow's OIDC token for trusted
 * publishing and attests provenance. The publish workflow runs it, with `bun scripts/publish.ts`, after the
 * release checks.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Where the tarballs are packed, removed at the end. */
const directory = mkdtempSync(join(tmpdir(), 'maximus-release-'));
try {
  const manifests = ['maximus', 'create-maximus'].map((name) => {
    const cwd = resolve('packages', name);
    const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8')) as {
      name: string;
      version: string;
    };
    return { cwd, manifest };
  });
  const versions = new Set(manifests.map(({ manifest }) => manifest.version));
  if (versions.size !== 1) {
    throw new Error(`The packages must share one version, not ${[...versions].join(' and ')}.`);
  }
  for (const { cwd, manifest } of manifests) {
    // A prerelease (4.0.0-next.0) goes out under its own tag (next), so `latest` never moves to it.
    const prerelease = /^\d+\.\d+\.\d+-([a-z]+)/.exec(manifest.version)?.[1];
    execFileSync('bun', ['pm', 'pack', '--destination', directory], { cwd, stdio: 'pipe' });
    const archive = `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`;
    execFileSync(
      'npm',
      [
        'publish',
        join(directory, archive),
        '--ignore-scripts',
        '--registry=https://registry.npmjs.org/',
        '--access=public',
        '--provenance',
        ...(prerelease ? ['--tag', prerelease] : []),
      ],
      { stdio: 'inherit' }
    );
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
