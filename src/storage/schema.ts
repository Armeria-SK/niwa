export const controlSchema = `
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('leader', 'member')),
  status TEXT NOT NULL CHECK(status IN ('active', 'dormant')),
  model TEXT NOT NULL,
  reasoning TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX one_leader ON agents(role) WHERE role = 'leader';
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  paused INTEGER NOT NULL CHECK(paused IN (0, 1)),
  generated_limit INTEGER NOT NULL CHECK(generated_limit >= 0),
  concurrency_limit INTEGER CHECK(concurrency_limit > 0),
  backup_days INTEGER NOT NULL CHECK(backup_days > 0)
) STRICT;
INSERT INTO settings VALUES (1, 0, 10, NULL, 14);
CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK(visibility IN ('shared', 'private'))
) STRICT;
CREATE TABLE participants (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  PRIMARY KEY(room_id, agent_id)
) STRICT;
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX messages_by_room ON messages(room_id);
`;

// Every agent gets its own database, including its search index and audit trail.
export const memorySchema = `
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  source_room_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE VIRTUAL TABLE memory_search USING fts5(id UNINDEXED, body, tokenize='trigram');
CREATE TRIGGER memory_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memory_search(id, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER memory_update AFTER UPDATE ON memories BEGIN
  DELETE FROM memory_search WHERE id = old.id;
  INSERT INTO memory_search(id, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER memory_delete AFTER DELETE ON memories BEGIN
  DELETE FROM memory_search WHERE id = old.id;
END;
CREATE TABLE memory_audit (
  sequence INTEGER PRIMARY KEY,
  memory_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('created', 'admin_corrected', 'deleted')),
  actor_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE memory_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  revision INTEGER NOT NULL
) STRICT;
INSERT INTO memory_state VALUES (1, 0);
`;

// Model transcripts can contain private memory. They stay in the owning bot's DB.
export const memoryMigrations = [memorySchema, `
CREATE TABLE task_steps (
  task_id TEXT NOT NULL,
  step INTEGER NOT NULL,
  memory_revision INTEGER NOT NULL,
  events TEXT NOT NULL,
  discarded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(task_id, step)
) STRICT;
`, `
CREATE TABLE task_plans (
  task_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0), memory_revision INTEGER NOT NULL,
  remaining TEXT NOT NULL, operation_id TEXT NOT NULL, input_hash TEXT NOT NULL
) STRICT;
CREATE TRIGGER invalidate_task_plans AFTER UPDATE OF revision ON memory_state BEGIN
  DELETE FROM task_plans;
END;
`, `
CREATE TABLE task_summaries (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, purpose TEXT NOT NULL, body TEXT NOT NULL,
  revision INTEGER NOT NULL, memory_revision INTEGER NOT NULL, operation_id TEXT NOT NULL, input_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE VIRTUAL TABLE summary_search USING fts5(id UNINDEXED,body,tokenize='trigram');
CREATE TRIGGER summary_insert AFTER INSERT ON task_summaries BEGIN
  INSERT INTO summary_search VALUES(new.id,new.purpose || char(10) || new.body); END;
CREATE TRIGGER summary_update AFTER UPDATE ON task_summaries BEGIN
  DELETE FROM summary_search WHERE id=old.id;
  INSERT INTO summary_search VALUES(new.id,new.purpose || char(10) || new.body); END;
CREATE TRIGGER summary_delete AFTER DELETE ON task_summaries BEGIN
  DELETE FROM summary_search WHERE id=old.id; END;
CREATE TRIGGER invalidate_task_summaries AFTER UPDATE OF revision ON memory_state BEGIN
  DELETE FROM task_summaries;
END;
`, `
CREATE TABLE procedures (id TEXT PRIMARY KEY,room_id TEXT NOT NULL,revision INTEGER NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN (0,1))) STRICT;
CREATE TABLE procedure_versions (
  procedure_id TEXT NOT NULL REFERENCES procedures(id) ON DELETE CASCADE,revision INTEGER NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL,
  PRIMARY KEY(procedure_id,revision)
) STRICT;
CREATE TABLE procedure_uses (
  task_id TEXT NOT NULL,operation_id TEXT NOT NULL,room_id TEXT NOT NULL,
  procedure_id TEXT NOT NULL REFERENCES procedures(id) ON DELETE CASCADE,revision INTEGER NOT NULL,applicability TEXT NOT NULL,created_at INTEGER NOT NULL,
  PRIMARY KEY(task_id,operation_id)
) STRICT;
CREATE TABLE procedure_receipts (task_id TEXT NOT NULL,operation_id TEXT NOT NULL,input_hash TEXT NOT NULL,output TEXT NOT NULL,PRIMARY KEY(task_id,operation_id)) STRICT;
CREATE TRIGGER invalidate_procedures AFTER UPDATE OF revision ON memory_state BEGIN DELETE FROM procedures; END;
`, `
ALTER TABLE task_steps ADD COLUMN rules_revision INTEGER NOT NULL DEFAULT 1;
`, `
CREATE INDEX memory_creation_order ON memory_audit(sequence,memory_id) WHERE action='created';
`, `
CREATE TABLE task_memory_reviews (
  task_id TEXT PRIMARY KEY, memory_revision INTEGER NOT NULL, rules_revision INTEGER NOT NULL
) STRICT;
`];
