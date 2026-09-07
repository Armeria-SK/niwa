export const externalSchema = `
CREATE TABLE external_operations (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  execution_id TEXT NOT NULL UNIQUE,
  output TEXT,
  PRIMARY KEY(task_id, operation_id)
) STRICT;
`;
