export const workNoteSchema = `
CREATE TABLE work_notes (
 id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 body TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 reply_id TEXT REFERENCES messages(id) ON DELETE SET NULL
) STRICT;
CREATE INDEX work_notes_task ON work_notes(task_id);
`;
