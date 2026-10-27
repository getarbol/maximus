/**
 * The MCP server's own description, written as Markdown in `mcp/`: `instructions.md` for every client that
 * connects, `guides/<name>.md` served as resources and prompts, and `skills/<name>.md` served as Agent Skills.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { checkMcpResourceNames } from '../../define-app.ts';
import type { McpConfiguration, McpGuide, McpSkill } from '../../manifest.ts';
import { compareNames } from './project-files.ts';

/** A guide's or a skill's name, from its file: lowercase letters and digits joined by single hyphens. */
const NAME = /^(?=.{1,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** One Markdown file of an `mcp/` folder: its name and its text. */
interface MarkdownFile {
  name: string;
  path: string;
  text: string;
}

/** The Markdown files of a folder of `mcp/`, by name. Symlinks and other names are refused. */
function markdownFiles(root: string, folder: string): MarkdownFile[] {
  const directory = join(root, folder);
  if (!existsSync(directory)) {
    return [];
  }
  if (lstatSync(directory).isSymbolicLink()) {
    throw new TypeError(`Project directory cannot be a symlink: ${folder}`);
  }
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith('.md') && !entry.name.startsWith('.'))
    .map((entry) => {
      const path = relative(root, join(directory, entry.name));
      if (!entry.isFile()) {
        throw new TypeError(`MCP Markdown must be an ordinary file: ${path}`);
      }
      const name = entry.name.slice(0, -'.md'.length);
      if (!NAME.test(name)) {
        throw new TypeError(`Name MCP Markdown in kebab-case, at most 64 characters: ${path}`);
      }
      return { name, path, text: readFileSync(join(directory, entry.name), 'utf-8') };
    })
    .toSorted((a, b) => compareNames(a.name, b.name));
}

/** A guide: its title is the `# heading` it starts with, and its text the whole Markdown. */
function guide({ name, path, text }: MarkdownFile): McpGuide {
  const title = /^# (.+)$/.exec(text.split(/\r?\n/, 1)[0] ?? '')?.[1]?.trim();
  if (!title) {
    throw new TypeError(`Start the guide with its # title: ${path}`);
  }
  return { name, title, text };
}

/**
 * A skill: frontmatter states its one-line `description` (and `name`, which must be its file's), as an
 * Agent Skill's `SKILL.md` does; the Markdown after it is the instructions.
 */
function skill({ name, path, text }: MarkdownFile): McpSkill {
  const document = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!document) {
    throw new TypeError(`Start the skill with frontmatter, ---, description: …, ---: ${path}`);
  }
  let description: string | undefined;
  for (const line of (document[1] ?? '').split(/\r?\n/).filter((entry) => entry.trim())) {
    const [, key, raw = ''] = /^([a-z-]+):\s*(.*?)\s*$/.exec(line) ?? [];
    // A quoted value is the text between its quotes.
    const value = /^(["'])(.*)\1$/.exec(raw)?.[2] ?? raw;
    if (key === 'description') {
      description = value || undefined;
    } else if (key !== 'name' || value !== name) {
      throw new TypeError(
        `A skill's frontmatter states its one-line description, and its name only as its file does: ${path}`
      );
    }
  }
  if (!description) {
    throw new TypeError(`State the skill's one-line description in its frontmatter: ${path}`);
  }
  return { name, description, text: document[2] ?? '' };
}

/** What `mcp/` describes of the MCP server, or nothing when it holds none of its Markdown. */
export function mcpMarkdown(root: string): McpConfiguration | undefined {
  const instructions = join(root, 'mcp/instructions.md');
  if (existsSync(instructions) && !lstatSync(instructions).isFile()) {
    throw new TypeError('MCP Markdown must be an ordinary file: mcp/instructions.md');
  }
  const guides = markdownFiles(root, 'mcp/guides').map(guide);
  const skills = markdownFiles(root, 'mcp/skills').map(skill);
  checkMcpResourceNames({ guides, skills });
  const configuration: McpConfiguration = {
    ...(existsSync(instructions) ? { instructions: readFileSync(instructions, 'utf-8') } : {}),
    ...(guides.length ? { guides } : {}),
    ...(skills.length ? { skills } : {}),
  };
  return Object.keys(configuration).length ? configuration : undefined;
}
