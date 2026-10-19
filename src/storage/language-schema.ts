import type { DatabaseSync } from 'node:sqlite';

/** The display language, shared by every browser that opens Niwa; the Bots are asked to reply in it too. Japanese until someone saves another. */
export const LANGUAGE_IDS = ['ja', 'en', 'ko', 'zh-CN'] as const;
export type LanguageId = typeof LANGUAGE_IDS[number];
/** Idempotent: databases rewound for upgrade tests may already carry the column. Adding the column is SQLite's in-place change,
 * so existing rows keep every other value and read back as Japanese. */
export function languageSchema(db: DatabaseSync): void {
  const columns = new Set(db.prepare('PRAGMA table_info(settings)').all().map(column => column.name));
  if (!columns.has('language')) db.exec(`ALTER TABLE settings ADD COLUMN language TEXT NOT NULL DEFAULT 'ja' CHECK(language IN (${LANGUAGE_IDS.map(id => `'${id}'`).join(',')}))`);
}
