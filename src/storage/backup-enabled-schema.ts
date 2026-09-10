export const backupEnabledSchema = `
ALTER TABLE settings ADD COLUMN backup_enabled INTEGER NOT NULL DEFAULT 1 CHECK (backup_enabled IN (0, 1));
`;
