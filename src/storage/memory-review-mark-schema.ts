/** How far each Bot's memory review of a conversation has reached, by message rowid, so Bot-to-Bot replies can review in batches without losing messages. */
export const memoryReviewMarkSchema = `
CREATE TABLE memory_review_marks (agent_id TEXT NOT NULL, room_id TEXT NOT NULL, message_rowid INTEGER NOT NULL, reviewed_at INTEGER NOT NULL, PRIMARY KEY(agent_id,room_id)) STRICT;
CREATE TABLE memory_review_snapshots (task_id TEXT PRIMARY KEY, message_rowid INTEGER NOT NULL) STRICT;
`;
