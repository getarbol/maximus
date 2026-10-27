/**
 * Prepares the packages before they are built: copies the canonical Agent Skill into Maximus and the
 * repository's LICENSE into each package.
 */
import { copyFileSync, cpSync, rmSync } from 'node:fs';

// Never edit the copies: edit .agents/skills and LICENSE.
rmSync('packages/maximus/skills', { recursive: true, force: true });
cpSync('.agents/skills/maximus', 'packages/maximus/skills/maximus', { recursive: true });
for (const name of ['maximus', 'create-maximus']) {
  copyFileSync('LICENSE', `packages/${name}/LICENSE`);
}
