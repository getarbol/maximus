# Notes in D1

A notes service whose notes live in a D1 database: one table keyed by organization, rows read back through
their schema, pages by keyset, and a search agents call over MCP.

```text
vite.config.ts                       The service, its Worker and the NOTES_DB binding
migrations/0001_notes.sql            The notes table, keyed (organization_id, note_id)
errors.ts                            NOTE_NOT_FOUND and INVALID_CURSOR
context.ts                           The caller's organization's notes, in every handler
src/notes.ts                         The note's schema and the store: every statement names the organization
routes/v1/notes/index.get.ts         GET    /api/v1/notes             (+ MCP list_notes)
routes/v1/notes/index.post.ts        POST   /api/v1/notes             201 Created
routes/v1/notes/[noteId].get.ts      GET    /api/v1/notes/{noteId}    (+ MCP get_note)
routes/v1/notes/[noteId].patch.ts    PATCH  /api/v1/notes/{noteId}
routes/v1/notes/[noteId].delete.ts   DELETE /api/v1/notes/{noteId}
mcp/tools/search-notes.ts            MCP only: search_notes
mcp/instructions.md                  What MCP clients read when they connect
tests/notes.test.ts                  The API, MCP and the store in Node, on SQLite with the same migrations
```

## Run it

```sh
bun install                          # once, at the repository root
cd examples/d1-notes
echo "DEVELOPMENT_TOKEN=$(openssl rand -hex 32)" > .dev.vars
bun run dev                          # http://localhost:5173
bun run migrate:local                # once, in another terminal: creates the table locally
```

```sh
TOKEN=$(cut -d= -f2 .dev.vars)
curl -s -X POST http://localhost:5173/api/v1/notes \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"Follow-up","body":"Call back on Monday."}'
curl -s 'http://localhost:5173/api/v1/notes?limit=10' -H "authorization: Bearer $TOKEN"
```

`vp dev` keeps the local database under `.cloudflare/state`, with the fixed id `migrate:local` applies the
migrations to. `bun run test` needs none of it: the tests run on Node's SQLite.

## Deploy it

Set `tokens.issuer` to your authorization server first: a deployed Worker accepts its access tokens alone.

```sh
bunx cf auth login
bunx cf d1 create --name maximus-example-notes      # prints the database id
export NOTES_DB_ID=<that id> WORKERS_SUBDOMAIN=<your workers.dev subdomain>
bun run migrate                                     # applies migrations/ to that database
bun run build && bunx cf deploy --prebuilt --mode production
```

A build without `NOTES_DB_ID` binds the local database's id, which no account holds, so it never deploys.

## What to notice

- The organization leads the table's keys, and every statement binds the verified
  `principal.organizationId`: no input a caller sends reaches another organization's notes.
- Rows are read through `NoteSchema` with `readSchema`: a row the schema refuses is the service's error,
  never an answer.
- Lists page by keyset over `(created_at, note_id)`, newest first, in either direction; a cursor the list
  never issued answers `INVALID_CURSOR`.
- `PATCH` takes the fields it changes, and at least one of them (`minProperties: 2`, with the path's id).
- Search escapes `%`, `_` and `\`, so the text matches itself.
