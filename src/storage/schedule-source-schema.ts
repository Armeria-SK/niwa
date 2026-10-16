// schedules.trigger_kind has a CHECK that SQLite cannot widen in place. External sources live beside it and the row keeps 'interval'.
// Only a SHA-256 of the webhook token is stored. pending/snapshot hold bounded untrusted external text for the next run and the next comparison.
export const scheduleSourceSchema = `
CREATE TABLE schedule_sources (
  schedule_id TEXT PRIMARY KEY REFERENCES schedules(id),
  kind TEXT NOT NULL CHECK(kind IN ('page_changes','webhook')),
  url TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  snapshot TEXT NOT NULL DEFAULT '',
  checked_at INTEGER,
  check_status TEXT,
  failures INTEGER NOT NULL DEFAULT 0 CHECK(failures >= 0),
  pending TEXT NOT NULL DEFAULT '',
  deliveries TEXT NOT NULL DEFAULT '[]'
) STRICT;
CREATE TRIGGER clear_schedule_sources AFTER UPDATE OF deleted ON schedules WHEN new.deleted=1 BEGIN
  DELETE FROM schedule_sources WHERE schedule_id=new.id;
END;
`;
