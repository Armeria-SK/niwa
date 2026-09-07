export const backupTimeSchema = `
ALTER TABLE settings ADD COLUMN backup_time TEXT NOT NULL DEFAULT '03:00';
`;
