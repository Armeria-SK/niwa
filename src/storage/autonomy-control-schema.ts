export const autonomyControlSchema = `
ALTER TABLE settings ADD COLUMN autonomous INTEGER NOT NULL DEFAULT 1 CHECK(autonomous IN (0,1));
`;
