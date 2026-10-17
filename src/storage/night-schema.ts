import type { DatabaseSync } from 'node:sqlite';

/** Idempotent: databases rewound for upgrade tests may already carry these changes.
 * Existing installations keep running at night as before (night_preview=0); a new installation turns the preview on when it is set up. */
export function nightSchema(db: DatabaseSync): void {
  const columns = new Set(db.prepare('PRAGMA table_info(settings)').all().map(column => column.name));
  if (!columns.has('night_preview')) db.exec('ALTER TABLE settings ADD COLUMN night_preview INTEGER NOT NULL DEFAULT 0 CHECK(night_preview IN (0,1))');
  db.exec(`CREATE TABLE IF NOT EXISTS night_plans (night TEXT PRIMARY KEY, decision TEXT NOT NULL CHECK(decision IN ('approved','skipped')),
    call_limit INTEGER NOT NULL CHECK(call_limit BETWEEN 1 AND 500), plan TEXT NOT NULL, decided_at INTEGER NOT NULL) STRICT`);
}
