// Missing preferences retain the existing global behavior.
export const agentAutonomySchema = `
CREATE TABLE agent_autonomy (
 agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
) STRICT;
`;
