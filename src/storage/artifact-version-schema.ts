export const artifactVersionSchema = `
CREATE TABLE artifact_versions (
 artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
 series_id TEXT NOT NULL, version INTEGER NOT NULL, parent_id TEXT,
 frozen INTEGER NOT NULL DEFAULT 0 CHECK(frozen IN (0,1)),
 UNIQUE(series_id,version)
) STRICT;
CREATE TABLE artifact_reviews (
 artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
 reviewer_id TEXT NOT NULL, sha256 TEXT NOT NULL,
 verdict TEXT NOT NULL CHECK(verdict IN ('approved','changes_requested')),
 note TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(artifact_id,reviewer_id)
) STRICT;
CREATE TABLE artifact_references (
 task_id TEXT NOT NULL REFERENCES tasks(id), artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
 sha256 TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(task_id,artifact_id)
) STRICT;
CREATE TABLE external_operation_labels (
 task_id TEXT NOT NULL,operation_id TEXT NOT NULL,tool_name TEXT NOT NULL,started_at INTEGER NOT NULL,
 PRIMARY KEY(task_id,operation_id),FOREIGN KEY(task_id,operation_id) REFERENCES external_operations(task_id,operation_id) ON DELETE CASCADE
) STRICT;
`;
