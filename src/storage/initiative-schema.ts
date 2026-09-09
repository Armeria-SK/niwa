export const initiativeSchema=`
CREATE TABLE initiative_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0) STRICT;
INSERT INTO initiative_settings VALUES(1,0);
CREATE TABLE initiatives(
 id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES agents(id),room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL,review_at INTEGER NOT NULL,
 review_reason TEXT NOT NULL DEFAULT '見直し時刻',signal TEXT NOT NULL DEFAULT '',last_checked INTEGER NOT NULL DEFAULT 0,stagnant INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE initiative_tasks(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,initiative_id TEXT NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE) STRICT;
CREATE TABLE initiative_evidence(initiative_id TEXT NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,reference TEXT NOT NULL,conclusion TEXT NOT NULL,kind TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,PRIMARY KEY(initiative_id,reference)) STRICT;
`;
