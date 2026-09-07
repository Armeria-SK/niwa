export const taskSchema = `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  requester_id TEXT NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  parent_id TEXT REFERENCES tasks(id),
  prompt TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','waiting_child','waiting_user','waiting_provider','completed','failed','cancelled')),
  result TEXT,
  wait_reason TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  deadline_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX tasks_queue ON tasks(state, created_at);
CREATE INDEX tasks_parent ON tasks(parent_id);
CREATE UNIQUE INDEX one_running_task_per_agent ON tasks(agent_id) WHERE state = 'running';
CREATE TABLE task_events (
  sequence INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE tool_receipts (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  operation_id TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT NOT NULL,
  PRIMARY KEY(task_id, operation_id)
) STRICT;
CREATE TABLE task_replies (
  sequence INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
`;
