export const workareasSchema = `
CREATE TABLE workarea_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,epoch TEXT NOT NULL) STRICT;
CREATE TABLE workareas(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('personal','project')),name TEXT NOT NULL,owner_id TEXT NOT NULL REFERENCES agents(id),room_id TEXT NOT NULL REFERENCES rooms(id),available INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1) STRICT;
CREATE UNIQUE INDEX personal_workarea ON workareas(owner_id,room_id) WHERE kind='personal' AND deleted=0 AND available=1;
CREATE TABLE workarea_members(area_id TEXT NOT NULL REFERENCES workareas(id),agent_id TEXT NOT NULL REFERENCES agents(id),PRIMARY KEY(area_id,agent_id)) STRICT;
CREATE TABLE task_workareas(task_id TEXT PRIMARY KEY REFERENCES tasks(id),area_id TEXT NOT NULL REFERENCES workareas(id)) STRICT;
CREATE TABLE artifact_audiences(artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,area_id TEXT NOT NULL REFERENCES workareas(id)) STRICT;
CREATE TABLE artifact_files(artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,blob_id TEXT NOT NULL,sha256 TEXT NOT NULL,size INTEGER NOT NULL,available INTEGER NOT NULL DEFAULT 1) STRICT;
CREATE TABLE retired_workarea_files(blob_id TEXT PRIMARY KEY) STRICT;
CREATE TRIGGER retire_workarea_file AFTER DELETE ON artifact_files BEGIN INSERT OR IGNORE INTO retired_workarea_files VALUES (old.blob_id); END;
`;
