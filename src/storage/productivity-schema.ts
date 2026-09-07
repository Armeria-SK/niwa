export const productivitySchema = `
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id),
  author_id TEXT NOT NULL REFERENCES agents(id), name TEXT NOT NULL,
  kind TEXT NOT NULL, description TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE updates (
  id INTEGER PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id),
  author_id TEXT NOT NULL REFERENCES agents(id), kind TEXT NOT NULL CHECK(kind IN ('done','decision','question')),
  title TEXT NOT NULL, detail TEXT NOT NULL, task_id TEXT REFERENCES tasks(id), artifact_id TEXT REFERENCES artifacts(id),
  created_at INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0 CHECK(seen IN (0,1))
) STRICT;
`;
