/**
 * The Maximus skill where coding agents look for skills: `.agents/skills/maximus`, `.claude/skills/maximus`
 * and `.codex/skills/maximus` link to the copy installed in `node_modules/@arbol-ai/maximus/skills/maximus`,
 * so agents always read the skill of the release the project runs.
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** The installed skill, from the project's root. */
const INSTALLED = 'node_modules/@arbol-ai/maximus/skills/maximus';
/** The folders coding agents read a project's skills from. */
const HARNESSES = ['.agents', '.claude', '.codex'] as const;

/**
 * Links the installed Maximus skill into each agent's skills folder of the project at `directory`, and
 * returns the links it created. A link already in place is kept; anything else at a link's path is refused,
 * never replaced. A link may point at nothing until `bun install` installs the package.
 */
export function linkAgentSkills(directory: string): string[] {
  const root = resolve(directory);
  const planned = HARNESSES.map((harness) => {
    const folder = join(root, harness, 'skills');
    const link = join(folder, 'maximus');
    return { folder, link, target: relative(folder, join(root, INSTALLED)) };
  });
  for (const { link, target } of planned) {
    const present = lstatSync(link, { throwIfNoEntry: false });
    if (present && !(present.isSymbolicLink() && readlinkSync(link) === target)) {
      throw new TypeError(`${relative(root, link)} exists and is not the Maximus skill link; move it first.`);
    }
  }
  const created: string[] = [];
  for (const { folder, link, target } of planned) {
    if (!existsSync(link) && !lstatSync(link, { throwIfNoEntry: false })) {
      mkdirSync(folder, { recursive: true });
      symlinkSync(target, link);
      created.push(relative(root, link));
    }
  }
  return created;
}
