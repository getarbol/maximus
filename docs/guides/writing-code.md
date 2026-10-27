# Write code people and agents read easily

Code is read far more often than it is written, by the people who maintain a service and by the coding
agents that change it. A Maximus project follows a few rules so that every route reads the same way and a
reader, human or not, understands a file without holding much in mind. The examples follow them, `maximus
gen route` writes files that follow them, and the Maximus skill teaches them to coding agents.

## A route reads from top to bottom

A route file holds three things, in this order: its imports, its handler and its contract.

```ts
// routes/v1/notes/[noteId].get.ts
import { defineHandler, UuidSchema } from '@arbol-ai/maximus';

import { NoteSchema } from '#src/notes.ts';

/** GET /api/v1/notes/{noteId}: one note of the caller's organization. */
export default defineHandler(
  async ({ input, notes, fail }) => {
    const note = await notes.find(input.noteId);
    if (!note) {
      return fail('NOTE_NOT_FOUND');
    }
    return note;
  },
  {
    description: 'Read one note of the organization by its id.',
    input: { noteId: UuidSchema },
    output: NoteSchema,
    failures: ['NOTE_NOT_FOUND'],
    mcp: { name: 'get_note' },
  }
);
```

The handler says what the route does; the contract says what it accepts, answers and may fail with. The
domain itself, how a note is stored and found, lives in `src/notes.ts`, and the handler only calls it.

## Write a handler as statements

Name each intermediate result, test one condition at a time and return early. A reader then follows the
handler one line at a time, without decoding an expression first.

| Instead of                                                      | Write                                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `(await notes.find(id)) ?? fail('NOTE_NOT_FOUND')`              | `const note = await notes.find(id);`, then `if (!note) { return fail('NOTE_NOT_FOUND'); }` |
| `'quote' in priced ? priced.quote : fail('UNKNOWN_SKU', …)`     | `if (!priced.ok) { return fail('UNKNOWN_SKU', …); }`, then `return priced.quote;`          |
| `a ? b : c ? d : e`                                             | An `if` for each case, or a function whose name says what it decides                       |
| `({ input: { noteId, ...fields }, notes })` with several levels | `({ input, notes })`, then `const { noteId, ...fields } = input;`                          |

Keep a handler to a few lines. When it grows a loop, a calculation or a second call to another service,
move that into a function of `src/` whose name says what it does, and call it.

## Put the domain in named functions

`src/` holds what the service is about: its schemas, its stores and its rules, each in a module named after
the domain (`src/notes.ts`, `src/reminders.ts`). `context.ts` builds what every handler needs, already
bound to the caller's organization, so no handler repeats the tenant:

```ts
// context.ts
import { defineContext } from '@arbol-ai/maximus';

import { noteStore } from '#src/notes.ts';

export default defineContext(({ env, principal }) => ({
  notes: noteStore(env.NOTES_DB, principal.organizationId),
}));
```

A store answers what was found or `undefined` when nothing was, and leaves the failure code to the route,
which declares it.

## Name things for what they are

- Use whole English words. Write `reminder`, `request` and `configuration`, never `rem`, `req` or `cfg`.
- Name data by what it holds, as a noun: `note`, `notes`, `dueAt`, `organizationId`. A collection is
  plural and each of its elements singular: `for (const note of notes)`.
- Name a function by what it does or answers, starting with a verb: `findNote`, `scheduleReminder`,
  `noteFromRow`. A function that answers a boolean reads as a question: `isOverdue`, `hasScope`.
- Put the unit in the name of a quantity: `timeoutMs`, `maxBytes`, `durationMicros`.
- Avoid names that say nothing: `data`, `info`, `item`, `value`, `result`, `obj`, `temp`, `helper`,
  `utils`, `manager`, `handle`. A name is good when a reader who sees only the name can guess the type.
- Name a module after its domain, not its kind: `src/reminders.ts`, not `src/helpers.ts` or `src/types.ts`.

## Write small functions

- A function does one thing, and its name says which.
- It takes at most three arguments; more become one options object with named fields.
- It never takes a boolean that switches what it does: write two functions instead.
- It returns early when it can, so its main path is not nested.
- It is async only when it awaits.
- Its comment says what it answers, and its body says how.

## Import your modules by name

A project's `package.json` maps `#src/*` to `./src/*`, so a module of `src/` has the same name from any
folder: `import { NoteSchema } from '#src/notes.ts'`, never `'../../../src/notes.ts'`. Bun, Vite, Vitest and
TypeScript all read the mapping, with no plugin. Import a type with `import type`, so the module it comes
from is not loaded for it.

## Comment declarations, not lines

- Every exported declaration has a JSDoc comment that says what it is or answers, in a sentence:
  `/** The notes of one organization, newest first. */`. Editors and agents show it where the name is used.
- A comment inside a function says why the code does something a reader would not expect, never what the
  next line does.
- A comment is updated with the code it describes, or removed.

## Fail with codes; throw only for the unexpected

An outcome the caller should handle (a missing note, a full slot, an unknown product) is a failure of your
catalog: the route declares its code in `failures` and answers `fail(code)`. An exception is for what no
caller can fix, such as a broken invariant, and Maximus answers it as `INTERNAL_ERROR` and reports it.
Never catch an error to answer empty data instead: a failure must stay a failure.

## Let the schema give the type

Declare a value's schema once and take its type from it with `Static<typeof NoteSchema>`. Avoid `as`, which
tells TypeScript to stop checking, and `any`, which turns checking off: read untrusted data through
`readSchema` or `checkSchema`, which answer the type only after checking it.

## Name tests as sentences

A test's name says the behavior it proves, as a sentence a reader can check against the code: `it('refuses
a note of another organization')`. A test arranges, acts and asserts once, uses synthetic data only and
never calls a live service. See [Testing](testing.md).

## For coding agents

The Maximus skill teaches these rules, so an agent writes a route the way this guide does. Link it into a
project with `bunx maximus skills` (`maximus init` does it already), and see
[the skill](../../.agents/skills/maximus/SKILL.md) for what it covers.
