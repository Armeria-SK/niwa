export const profileSchema = `CREATE TABLE agent_profiles(agent_id TEXT PRIMARY KEY REFERENCES agents(id), profile TEXT NOT NULL) STRICT;`;
