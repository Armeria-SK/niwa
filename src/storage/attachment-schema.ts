// Administrator-provided text files. Rows follow their message, including room deletion and restore.
export const attachmentSchema = `
CREATE TABLE message_attachments (
 id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 4), name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 size INTEGER NOT NULL CHECK(size BETWEEN 0 AND 262144), sha256 TEXT NOT NULL, body TEXT NOT NULL,
 UNIQUE(message_id,position)
) STRICT;
`;
