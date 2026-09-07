export const scheduleTriggerSchema = `
ALTER TABLE schedules ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT 'interval' CHECK(trigger_kind IN ('interval','shared_changes'));
ALTER TABLE schedules ADD COLUMN source_revision TEXT NOT NULL DEFAULT '';
`;
