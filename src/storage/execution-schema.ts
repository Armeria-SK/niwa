export const executionSchema=`
CREATE TABLE execution_bindings(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,area_id TEXT NOT NULL REFERENCES workareas(id),epoch TEXT NOT NULL,lease TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',waiting INTEGER NOT NULL DEFAULT 0,result TEXT) STRICT;
CREATE UNIQUE INDEX task_pending_execution ON execution_bindings(task_id) WHERE state='pending';
`;
