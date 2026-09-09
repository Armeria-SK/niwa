export const activitySchema = `
CREATE TABLE task_message_links (
 message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, PRIMARY KEY(message_id,task_id)
) STRICT;
CREATE TABLE task_context (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, related_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL
) STRICT;
CREATE TABLE task_child_dependencies(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, required INTEGER NOT NULL CHECK(required IN (0,1))) STRICT;
CREATE TABLE task_memory_skips(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,memory_revision INTEGER NOT NULL,rules_revision INTEGER NOT NULL,created_at INTEGER NOT NULL) STRICT;
CREATE TABLE task_activity (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 call_id TEXT NOT NULL, lease TEXT NOT NULL, memory_revision INTEGER NOT NULL, rules_revision INTEGER NOT NULL,
 phase TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE task_waits (task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, kind TEXT NOT NULL) STRICT;
CREATE TABLE task_observations (
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, operation_id TEXT NOT NULL,
 memory_revision INTEGER NOT NULL, rules_revision INTEGER NOT NULL, name TEXT NOT NULL,
 fingerprint TEXT NOT NULL, result TEXT NOT NULL, failure TEXT, created_at INTEGER NOT NULL,
 PRIMARY KEY(task_id,operation_id)
) STRICT;
`;
