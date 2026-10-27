# Writing code people and agents read easily

The house style of a Maximus project. Follow it in every file you write or change, and keep the code you
touch in it. The full guide, with its reasons, is
[Write code people and agents read easily](https://github.com/getarbol/maximus/blob/main/docs/guides/writing-code.md).

## A route file

Imports, then the handler, then the contract. The handler says what the route does; the contract what it
accepts, answers and may fail with; the domain lives in `src/`.

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

## Handlers are statements

| Never                                                     | Write                                                                            |
| --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `(await notes.find(id)) ?? fail('NOTE_NOT_FOUND')`        | `const note = await notes.find(id);` then `if (!note) { return fail(…); }`       |
| `'quote' in priced ? priced.quote : fail('UNKNOWN_SKU')`  | `if (!priced.ok) { return fail('UNKNOWN_SKU', …); }` then `return priced.quote;` |
| Nested ternaries                                          | One `if` per case, or a function whose name says what it decides                 |
| Destructuring several levels deep in the parameter list   | `({ input, notes })`, then `const { noteId, ...fields } = input;`                |
| A loop, a calculation or a second service call in a route | A named function in `src/` that the handler calls                                |

## Modules and imports

- `src/` holds the domain, one module per subject: `src/notes.ts`, `src/reminders.ts`. Never
  `src/utils.ts`, `src/helpers.ts` or `src/types.ts`.
- Import a module of `src/` by its name, `#src/notes.ts`, never `../../../src/notes.ts`; the project's
  `package.json` maps `#src/*` to `./src/*`. Inside `src/`, a module imports its neighbor as `./x.ts`.
- `import type` for types. Keep the `.ts` extension.
- `context.ts` builds what every handler needs, bound to `principal.organizationId`, so no handler repeats
  the tenant. A store answers the value it found or `undefined`; the route owns the failure code.

## Names

- Whole English words: `reminder`, `request`, `configuration`; never `rem`, `req`, `cfg`.
- Data is a noun (`note`, `notes`, `dueAt`); a collection is plural and its element singular.
- A function starts with a verb (`findNote`, `scheduleReminder`, `noteFromRow`); one that answers a boolean
  reads as a question (`isOverdue`, `hasScope`).
- A quantity carries its unit: `timeoutMs`, `maxBytes`, `durationMicros`.
- Never `data`, `info`, `item`, `value`, `result`, `obj`, `temp`, `helper`, `utils`, `manager`, `handle`.
- A route needs no name: `GET /v1/notes/{noteId}` is `getNote` and `POST /v1/notes/{noteId}/archive` is
  `archiveNote`. Declare `operationId` only where the derived name reads wrong. Shape paths so it reads
  right: plural collections (`/v1/notes`), parameters for items (`/{noteId}`), verbs for POST actions
  (`/archive`, `/mark-read`, `/search`).

## Functions and comments

- One thing per function, at most three arguments (then one options object), no boolean that switches
  behavior, early returns, `async` only when it awaits.
- Every exported declaration has a one-sentence JSDoc saying what it is or answers. A comment inside a
  function says why, never what the next line does. Update or delete a comment with its code.

## Failures, types and tests

- An outcome the caller handles is a declared failure: list its code in `failures` and return `fail(code)`.
  Throw only for what no caller can fix. Never turn an error into empty data.
- Take types from schemas (`Static<typeof NoteSchema>`). No `as` casts or `any` in place of a check: read
  untrusted data with `readSchema` or `checkSchema`.
- A test's name is the behavior it proves, as a sentence: `it('refuses a note of another organization')`.
  Arrange, act and assert once; synthetic data only; never a live service.
