/**
 * Prepares the package before it is built: copies the canonical Agent Skill and the repository's LICENSE
 * into it.
 */
import { copyFileSync, cpSync, rmSync } from 'node:fs';

// Never edit the copies: edit .agents/skills and LICENSE.
rmSync('packages/maximus/skills', { recursive: true, force: true });
cpSync('.agents/skills/maximus', 'packages/maximus/skills/maximus', { recursive: true });
copyFileSync('LICENSE', 'packages/maximus/LICENSE');
