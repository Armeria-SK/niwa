export const autonomySchema = `
ALTER TABLE schedules ADD COLUMN autonomous INTEGER NOT NULL DEFAULT 0 CHECK(autonomous IN (0,1));
`;
