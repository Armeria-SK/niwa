export const coordinationSchema = `
ALTER TABLE tasks ADD COLUMN source_message_id TEXT;
CREATE TABLE message_acknowledgments (
 message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 agent_id TEXT NOT NULL REFERENCES agents(id), created_at INTEGER NOT NULL,
 PRIMARY KEY(message_id,agent_id)
) STRICT;
CREATE TABLE task_coordination (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id), revision INTEGER NOT NULL,
 completion_condition TEXT NOT NULL, stop_condition TEXT NOT NULL,
 blocker TEXT NOT NULL, waiting_for TEXT, next_agent_id TEXT,
 updated_at INTEGER NOT NULL
) STRICT;
`;
