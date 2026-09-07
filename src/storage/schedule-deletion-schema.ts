export const scheduleDeletionSchema = `
ALTER TABLE schedules ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1));
`;
