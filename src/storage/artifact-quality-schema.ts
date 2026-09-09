export const artifactQualitySchema=`
CREATE TABLE quality_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0) STRICT;
INSERT INTO quality_settings VALUES(1,0);
CREATE TABLE task_quality(task_id TEXT PRIMARY KEY REFERENCES tasks(id),revision INTEGER NOT NULL,body TEXT NOT NULL) STRICT;
CREATE TABLE artifact_quality(artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,body TEXT NOT NULL) STRICT;
CREATE TABLE artifact_manifest(artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,path TEXT NOT NULL,child_id TEXT NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(artifact_id,path)) STRICT;
CREATE TABLE artifact_evidence(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,sha256 TEXT NOT NULL,criterion TEXT NOT NULL,author_id TEXT NOT NULL,source_task TEXT NOT NULL,source_operation TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
ALTER TABLE artifact_reviews ADD COLUMN review_model TEXT;
ALTER TABLE artifact_reviews ADD COLUMN checks TEXT;
ALTER TABLE artifact_reviews ADD COLUMN evidence_revision TEXT;
`;
