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
