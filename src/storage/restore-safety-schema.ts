export const restoreSafetySchema = `
CREATE TABLE restored_tasks(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE) STRICT;
`;
