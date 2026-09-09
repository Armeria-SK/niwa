export const autonomousContinuitySchema = `
ALTER TABLE autonomous_wakes ADD COLUMN evidence TEXT NOT NULL DEFAULT '';
ALTER TABLE autonomous_wakes ADD COLUMN stagnant INTEGER NOT NULL DEFAULT 0;
CREATE TABLE autonomous_boundaries (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id),
 held_tasks TEXT NOT NULL
) STRICT;
`;
