export const autonomousWakeSchema = `
ALTER TABLE tasks ADD COLUMN internal_autonomous INTEGER NOT NULL DEFAULT 0 CHECK(internal_autonomous IN (0,1));
CREATE TABLE autonomous_wakes (
 agent_id TEXT PRIMARY KEY REFERENCES agents(id),
 task_id TEXT REFERENCES tasks(id),
 next_at INTEGER NOT NULL,
 last_started_at INTEGER NOT NULL DEFAULT 0,
 model_calls INTEGER NOT NULL DEFAULT 0,
 budget_reset_at INTEGER NOT NULL DEFAULT 0,
 failures INTEGER NOT NULL DEFAULT 0,
 reason TEXT NOT NULL
) STRICT;
`;
