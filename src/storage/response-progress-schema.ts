export const responseProgressSchema = `
CREATE TABLE response_progress (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 anchor_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
 reply_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
 memory_revision INTEGER NOT NULL, rules_revision INTEGER NOT NULL,
 started_at INTEGER NOT NULL, finished_at INTEGER
) STRICT;
CREATE UNIQUE INDEX response_progress_open ON response_progress(task_id) WHERE finished_at IS NULL;
CREATE TABLE provider_failures (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 code TEXT NOT NULL,retryable INTEGER NOT NULL,attempts INTEGER NOT NULL,reset_at INTEGER,created_at INTEGER NOT NULL
) STRICT;
`;
