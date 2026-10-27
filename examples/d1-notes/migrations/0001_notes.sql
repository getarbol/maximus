-- The notes of every organization. The organization leads the primary key and the index: the store names it
-- in every statement, and each lookup reads one organization's rows.
CREATE TABLE notes (
  organization_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, note_id)
) WITHOUT ROWID;

-- The keyset order lists use: newest first, ties broken by id.
CREATE INDEX notes_by_creation ON notes (organization_id, created_at, note_id);
