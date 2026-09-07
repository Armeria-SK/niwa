export const scheduleSchema = `
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  prompt TEXT NOT NULL,
  interval_ms INTEGER NOT NULL CHECK(interval_ms >= 60000),
  next_at INTEGER NOT NULL,
  max_runs INTEGER NOT NULL CHECK(max_runs > 0),
  timeout_ms INTEGER NOT NULL CHECK(timeout_ms > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  run_count INTEGER NOT NULL DEFAULT 0,
  failure_reset INTEGER NOT NULL DEFAULT 0,
  wait_reason TEXT,
  input_hash TEXT NOT NULL
) STRICT;
CREATE TABLE schedule_runs (
  schedule_id TEXT NOT NULL REFERENCES schedules(id),
  scheduled_at INTEGER NOT NULL,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  PRIMARY KEY(schedule_id, scheduled_at)
) STRICT;
`;
