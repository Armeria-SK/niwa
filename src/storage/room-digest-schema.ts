/**
 * 会話のまとめ: one rolling, cited digest per conversation, the versions running tasks still read, the claim that lets one task at a time
 * refresh it, an audit of changes (ids only), and each task's pinned view of the conversation. Idempotent for upgrade replays.
 */
export const roomDigestSchema = `
CREATE TABLE IF NOT EXISTS room_digests (room_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, cutoff_rowid INTEGER NOT NULL, body TEXT NOT NULL,
  task_id TEXT, agent_id TEXT, model TEXT, updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS room_digest_versions (room_id TEXT NOT NULL, revision INTEGER NOT NULL, cutoff_rowid INTEGER NOT NULL, body TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY(room_id,revision)) STRICT;
CREATE TABLE IF NOT EXISTS room_digest_claims (room_id TEXT PRIMARY KEY, task_id TEXT, claimed_at INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE IF NOT EXISTS room_digest_audit (room_id TEXT NOT NULL, revision INTEGER NOT NULL, item_id TEXT, action TEXT NOT NULL,
  actor_id TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS task_room_views (task_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('full','shadow','digest')),
  digest_revision INTEGER NOT NULL DEFAULT 0, cutoff_rowid INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL) STRICT;
`;
