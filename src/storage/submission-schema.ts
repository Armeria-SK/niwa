export const submissionSchema = `
CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  input_hash TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id),
  task_id TEXT REFERENCES tasks(id)
) STRICT;
`;
