export const promptSchema=`
CREATE TABLE task_prompt_versions(task_id TEXT PRIMARY KEY REFERENCES tasks(id),version TEXT NOT NULL CHECK(version IN ('legacy-v4','structured-v5'))) STRICT;
CREATE TABLE prompt_runs(id INTEGER PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),version TEXT NOT NULL,phase TEXT NOT NULL,rules_revision INTEGER NOT NULL,memory_revision INTEGER NOT NULL,input_bytes INTEGER NOT NULL,estimated_input_tokens INTEGER NOT NULL,removed_messages INTEGER NOT NULL,created_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'unknown',input_tokens INTEGER,output_tokens INTEGER) STRICT;
`;
