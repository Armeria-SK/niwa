export const modelRouteSchema = `
CREATE TABLE model_routes (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('configured','quota')),
  attempted_at INTEGER NOT NULL
) STRICT;
`;
