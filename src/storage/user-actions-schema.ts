/** Structured replies and idempotent member creation from the administrator UI. */
export const userActionsSchema = `
ALTER TABLE messages ADD COLUMN reply_to TEXT REFERENCES messages(id) ON DELETE SET NULL;
CREATE TABLE member_requests (
  id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id)
) STRICT;
`;
