# CLI

`@arbol-ai/maximus` installs the `maximus` command, which creates projects, writes route and tool files,
links the Maximus skill for coding agents and prepares `.maximus/`. `create-maximus` creates a project from a
terminal. This page lists every command and option, what each prints and how each fails.

Vite+ develops, tests and builds a project (`vp dev`, `vp test`, `vp build`) and Cloudflare's `cf` deploys
it; `maximus` wraps neither.

## Running it

In a project that depends on `@arbol-ai/maximus`, run `bunx maximus <command>`, or `maximus <command>` in
a package script, as the starter's `prepare` and `typecheck` scripts do. Outside such a project,
`bunx maximus` runs another npm package named `maximus`: create a project with `bun create maximus`.

```text
Usage: maximus init <new-directory> [--name <name>] [--web] [--no-mcp]
       maximus gen route <method> <path> [--tool <mcp_tool_name>] [--root <directory>]
       maximus gen tool <name> [--root <directory>]
       maximus skills [directory]
       maximus prepare [directory] [--mode production|development]
```

## Output and exit status

- A command that succeeds says what it did in a sentence, `init` in two, and exits with 0. With `--json` it
  prints that as one line of JSON instead, for scripts.
- A command that fails prints one line on standard error, `maximus: <message>`, and exits with 1. With
  `MAXIMUS_DEBUG=1` in the environment it prints the error itself, with its stack.
- An unknown option and an option without its value fail the same way:
  `maximus: Unknown option '--nme'…` and `maximus: Option '--name <value>' argument missing…`.
- `--help` prints the usage and exits with 0. No command, or an unknown one, prints the usage on standard
  error and exits with 1.

## maximus init

```sh
maximus init <new-directory> [--name <name>] [--web] [--no-mcp] [--json]
```

Creates a project in a directory that does not exist yet.

| Argument          | Default                  | Effect                                                                                                           |
| ----------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `<new-directory>` | Required                 | Where the project is written.                                                                                    |
| `--name <name>`   | The directory's own name | The package's name, and so the Worker's and the scopes' namespace: lowercase kebab-case, 2 to 41 characters.     |
| `--web`           | No web app               | Adds a React web app: `index.html` and `app/`, which answer `/` in place of `pages/index.ts`.                    |
| `--no-mcp`        | MCP on                   | Leaves MCP out: the greeting route names no tool, and neither `mcp/instructions.md` nor the MCP test is written. |

The project depends on the release of the `maximus` that created it, its compatibility date is the day it
was created, and it holds the starter's files, which
[Getting started](../getting-started.md#create-the-project) lists. `init` also writes `.dev.vars` with a
fresh development token that only its owner can read, links `AGENTS.md` to `CLAUDE.md` and the project's
own skill into `.claude/skills/` and `.codex/skills/`, and links the Maximus skill as `maximus skills`
does.

```text
Created notes in notes/: an API and its MCP server.
Run bun install and bun run dev. Set origin and tokens.issuer in vite.config.ts before the first deployment; bun run verify runs the types, lint, tests and build, and bun run deploy deploys.
```

The first sentence ends `an API.` with `--no-mcp`, and `with a web app.` with `--web`. With `--json` it
prints this object, on one line:

```json
{
  "directory": "/home/dev/notes",
  "mcp": true,
  "web": false,
  "skills": [".agents/skills/maximus", ".claude/skills/maximus", ".codex/skills/maximus"],
  "next": "Run bun install and bun run dev. …"
}
```

`directory` is absolute, `skills` lists the links it created and `next` is the second sentence.

| Refusal                                                            | When                                                     |
| ------------------------------------------------------------------ | -------------------------------------------------------- |
| `Use maximus init <new-directory> [--name <name>].`                | No directory is given.                                   |
| `Use a lowercase kebab-case project name of 2 to 41 characters.`   | The name, given or taken from the directory, is not one. |
| `Choose a new directory; existing projects are never overwritten.` | The directory exists, even empty.                        |

## maximus gen route

```sh
maximus gen route <method> <path> [--tool <mcp_tool_name>] [--root <directory>] [--json]
```

Writes a route file where prepare reads it.

| Argument             | Default  | Effect                                                                                                                                                                             |
| -------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<method>`           | Required | `get`, `post`, `put`, `patch` or `delete`, in any case.                                                                                                                            |
| `<path>`             | Required | The route's path, starting with its version: `/v1/notes/{noteId}`, `v1/notes/:noteId` and `/v1/notes/[noteId]` are the same path. A leading `/api` before the version is left out. |
| `--tool <name>`      | None     | Makes the route the MCP tool of that name too, in snake case, such as `get_note`.                                                                                                  |
| `--root <directory>` | `.`      | The project's root.                                                                                                                                                                |

The file is `routes/<path>.<method>.ts`, or `routes/<path>/index.<method>.ts` when `routes/<path>/` is a
folder already. Its handler answers the path's parameters back, and its contract holds a description to
rewrite, the parameters as `input` and `output`, and `mcp` with `--tool`:

```ts
import { defineHandler, t } from '@arbol-ai/maximus';

/** GET /v1/notes/{noteId} below the API's base path, and the MCP tool get_note. */
export default defineHandler(({ input }) => ({ noteId: input.noteId }), {
  description: 'Describe what GET /v1/notes/{noteId} does for its caller.',
  input: { noteId: t.String() },
  output: { noteId: t.String() },
  mcp: { name: 'get_note' },
});
```

```text
Wrote routes/v1/notes/[noteId].get.ts: GET /v1/notes/{noteId}, also the MCP tool get_note.
```

The file is named relative to the directory the command runs in. With `--json`:
`{"file":"/home/dev/notes/routes/v1/notes/[noteId].get.ts","method":"GET","path":"/v1/notes/{noteId}"}`.

| Refusal                                                                                  | When                                                                                    |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `Use maximus gen route <method> <path>, or maximus gen tool <name>.`                     | The arguments are not one of the two forms.                                             |
| `Choose a route method: get, post, put, patch, delete.`                                  | Another method.                                                                         |
| `A route lives below its API version, such as /v1/tasks: <path>`                         | The path does not start with a version, or stops at it.                                 |
| `Use letters, digits, _ and - in a fixed segment, and {name} for a parameter: <segment>` | A segment is neither.                                                                   |
| `Path parameter names must be unique and safe: <path>`                                   | The path names one parameter twice, or a parameter called `constructor` or `prototype`. |
| `Name an MCP tool in snake_case, such as get_task: <name>`                               | `--tool` names a tool otherwise.                                                        |
| `<file> already answers <METHOD> <path>.`                                                | A route file answers that method and path, parameter names aside.                       |
| `<file> exists; edit it instead.`                                                        | The file exists.                                                                        |
| `Project directory cannot be a symlink: <folder>`                                        | A folder on the way to the file is a link.                                              |

## maximus gen tool

```sh
maximus gen tool <name> [--root <directory>] [--json]
```

Writes `mcp/tools/<name>.ts`, a tool only MCP serves. `<name>` is the file's kebab-case name, and the tool
is its snake case: `summarize-notes` is the tool `summarize_notes`. The tool reads, takes a `text` and
answers it back, with a description to rewrite.

```text
Wrote mcp/tools/summarize-notes.ts: the MCP tool summarize_notes.
```

With `--json`: `{"file":"/home/dev/notes/mcp/tools/summarize-notes.ts","tool":"summarize_notes"}`.

| Refusal                                                           | When                                  |
| ----------------------------------------------------------------- | ------------------------------------- |
| `Name a tool file in kebab-case, such as summarize-tasks: <name>` | The name is not lowercase kebab-case. |
| `<file> exists; edit it instead.`                                 | The file exists.                      |
| `Project directory cannot be a symlink: <folder>`                 | `mcp/` or `mcp/tools/` is a link.     |

## maximus skills

```sh
maximus skills [directory] [--json]
```

Links the Maximus skill into the folders coding agents read skills from: `.agents/skills/maximus`,
`.claude/skills/maximus` and `.codex/skills/maximus` each point at
`node_modules/@arbol-ai/maximus/skills/maximus`, so agents read the skill of the release the project runs.
`directory` is the project's root, `.` by default. A link already in place is kept, and a link points at
nothing until `bun install` installs the package.

```text
Linked the Maximus skill for coding agents: .agents/skills/maximus, .claude/skills/maximus, .codex/skills/maximus.
```

When every link is in place it prints `The Maximus skill was already linked for coding agents.` With
`--json`: `{"linked":[…]}`, the links it created.

| Refusal                                                           | When                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------ |
| `<link> exists and is not the Maximus skill link; move it first.` | Something else is at a link's path; nothing is linked. |
| `Project directory cannot be a symlink: <folder>`                 | An agent's folder or its `skills` folder is a link.    |

## maximus prepare

```sh
maximus prepare [directory] [--mode production|development] [--json]
```

Writes `.maximus/` for the project at `directory`, `.` by default. It loads the project's Vite configuration
with Vite, the first of `vite.config.js`, `.mjs`, `.ts`, `.cjs`, `.mts` and `.cts` it finds, as every `vp`
command does, and prepares the project through the `maximus()` plugin it configures: for `production`, as a
build does, by default, or for `development`, as `vp dev` does. It reads the project's modules without
running them. [Project structure](../guides/project-structure.md#what-prepare-generates) describes what it
writes.

```text
Prepared .maximus/ for production: 5 routes, 1 MCP tool, 1 page.
```

It says `Prepared` when a module changed and `Kept` when none did, then counts what it found: routes, MCP
tools, pages, middleware modules, crons, queues, email handlers, Durable Objects and app pages, or
`no modules`. With `--json` it prints what it found:

| Field            | Value                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `directory`      | The project's root, absolute.                                                                                                            |
| `mode`           | `production` or `development`.                                                                                                           |
| `changed`        | Whether any module of `.maximus/` changed.                                                                                               |
| `durableObjects` | The modules of `durable-objects/`.                                                                                                       |
| `crons`          | Each cron module, `{ file, cron }`, with its schedule, or no `cron` when it states none as a literal.                                    |
| `queues`         | The queues the queue modules consume.                                                                                                    |
| `webApp`         | Whether the project is a web app.                                                                                                        |
| `files`          | Every module and page prepare read.                                                                                                      |
| `modules`        | How many modules each convention holds: `routes`, `mcp`, `pages`, `middleware`, `crons`, `queues`, `email`, `durable-objects` and `app`. |

| Refusal                                                                               | When                                     |
| ------------------------------------------------------------------------------------- | ---------------------------------------- |
| `Prepare with --mode production, as a build does, or development, as vp dev does.`    | Another mode.                            |
| `Configure the project in vite.config.ts with maximus() from @arbol-ai/maximus/vite.` | The directory has no Vite configuration. |
| `<file> configures no maximus() plugin from @arbol-ai/maximus/vite.`                  | Its configuration has no `maximus()`.    |

Prepare's own refusals are listed in [Project structure](../guides/project-structure.md#what-prepare-refuses),
and those of `maximus()`'s options in [Configuration](configuration.md#refusals).

## create-maximus

```sh
bun create maximus [directory] [--name <name>] [--web] [--no-mcp] [--yes]
npm create maximus@latest [directory] [--name <name>] [--web] [--no-mcp] [--yes]
```

Creates a project with `maximus init` of the release `create-maximus` depends on.

| Argument            | Default                   | Effect                                                               |
| ------------------- | ------------------------- | -------------------------------------------------------------------- |
| `[directory]`       | Asked, else `maximus-app` | Where the project is written.                                        |
| `--name <name>`     | The directory's own name  | The project's name, as for `maximus init`.                           |
| `--web`, `--no-web` | Asked, else no web app    | Whether the project is also a React web app.                         |
| `--mcp`, `--no-mcp` | Asked, else MCP on        | Whether its routes can be MCP tools.                                 |
| `--yes`, `-y`       | Off                       | Takes the defaults for what the arguments leave out, without asking. |
| `--help`            |                           | Prints the usage.                                                    |

In a terminal it asks only what the arguments leave out:

```text
Project directory (maximus-app):
Serve its routes to agents over MCP? (Y/n)
Add a React web app? (y/N)
```

An empty answer takes the default: `maximus-app`, MCP on and no web app. `y`, `yes`, `n` and `no` answer in
any case, and any other answer is refused with `Answer yes or no, not <answer>.` Outside a terminal, the
arguments and the defaults decide. Once the project is written, it says what to run next:

```text
Created notes, an API and its MCP server.

  cd notes
  bun install
  bun run dev

Set origin and tokens.issuer in vite.config.ts before the first deployment.
```

A refusal of `maximus init` is printed as `maximus: <message>`, and any other failure as
`create-maximus: <message>`, such as `create-maximus: Name one directory for the project.` for two
directories. Either exits with 1.
