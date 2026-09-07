export const organizationSchema = `
CREATE TABLE room_preferences (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1))
) STRICT;
`;
