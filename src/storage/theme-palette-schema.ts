import type { DatabaseSync } from 'node:sqlite';
import { editSchema } from './database.ts';
import { THEME_IDS } from './theme-schema.ts';

const check = (ids: readonly string[]) => `CHECK(theme IS NULL OR theme IN (${ids.map(id => `'${id}'`).join(',')}))`;
/** The six themes themeSchema allowed when the column was added; THEME_IDS keeps them first and adds six more after them. */
const PREVIOUS = check(['auto', 'garden', 'sand', 'mist', 'lilac', 'night']);
const NEXT = check(THEME_IDS);

/** Idempotent: databases rewound for upgrade tests may already carry the wider list.
 * Widens settings.theme to every id in THEME_IDS with the same constraint-only schema edit as anthropicSchema
 * (no stored theme changes, so nothing needs rewriting) and fails closed when the text differs. */
export function themePaletteSchema(db: DatabaseSync): void {
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='settings'").get();
  const sql = typeof row?.sql === 'string' ? row.sql : '';
  if (sql.split(NEXT).length === 2) return;
  if (sql.split(PREVIOUS).length !== 2) throw new Error('Unexpected settings schema');
  const version = Number(db.prepare('PRAGMA schema_version').get()!.schema_version);
  editSchema(db, () => {
    db.prepare("UPDATE sqlite_schema SET sql=? WHERE type='table' AND name='settings'").run(sql.replace(PREVIOUS, NEXT));
    db.exec(`PRAGMA schema_version=${version + 1}`);
  });
  const result = db.prepare('PRAGMA integrity_check').all();
  if (result.length !== 1 || result[0]!.integrity_check !== 'ok') throw new Error('Schema integrity check failed');
}
