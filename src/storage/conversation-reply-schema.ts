export const conversationReplySchema = `
ALTER TABLE tasks ADD COLUMN conversation_reply INTEGER NOT NULL DEFAULT 0 CHECK(conversation_reply IN (0,1));
`;
