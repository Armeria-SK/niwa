export const deletionSchema = `
CREATE TABLE deletion_records (
  agent_id TEXT NOT NULL, memory_id TEXT NOT NULL, revision INTEGER NOT NULL,
  PRIMARY KEY(agent_id,memory_id)
) STRICT;
`;
