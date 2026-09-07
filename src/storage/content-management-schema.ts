export const contentManagementSchema = `
CREATE TABLE deleted_content(kind TEXT NOT NULL CHECK(kind IN ('room','artifact')),id TEXT NOT NULL,deleted_at INTEGER NOT NULL,PRIMARY KEY(kind,id)) STRICT;
CREATE TABLE business_tasks(task_id TEXT PRIMARY KEY REFERENCES tasks(id),title TEXT NOT NULL,detail TEXT NOT NULL) STRICT;
CREATE TABLE approval_requests(task_id TEXT PRIMARY KEY REFERENCES tasks(id),title TEXT NOT NULL,detail TEXT NOT NULL,version TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','approved','declined'))) STRICT;
`;
