export const conversationSchema = `
CREATE TABLE conversation_requests (
  id TEXT PRIMARY KEY,
  input_hash TEXT NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms(id)
) STRICT;
`;
