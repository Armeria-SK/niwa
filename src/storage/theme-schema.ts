import type { DatabaseSync } from 'node:sqlite';

/** The chosen color theme, shared by every browser that opens Niwa. NULL until someone saves one; each browser keeps its own choice until then. */
export const THEME_IDS = ['auto', 'garden', 'sand', 'mist', 'lilac', 'night'] as const;
/** Idempotent: databases rewound for upgrade tests may already carry the column. */
export function themeSchema(db: DatabaseSync): void {
  const columns = new Set(db.prepare('PRAGMA table_info(settings)').all().map(column => column.name));
  if (!columns.has('theme')) db.exec(`ALTER TABLE settings ADD COLUMN theme TEXT CHECK(theme IS NULL OR theme IN (${THEME_IDS.map(id => `'${id}'`).join(',')}))`);
}
