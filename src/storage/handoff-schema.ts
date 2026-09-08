export const handoffSchema=`
CREATE TABLE task_handoffs (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id),
 artifact_id TEXT NOT NULL,
 sha256 TEXT NOT NULL,
 child_id TEXT REFERENCES tasks(id)
) STRICT;
`;
