import type { DatabaseSync } from 'node:sqlite';

/** Idempotent: databases rewound for upgrade tests may already carry this table.
 * Pairs of memories the administrator marked as "not a conflict". The key includes both revisions, so a correction brings the pair back. */
export function memoryConflictSchema(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS memory_conflict_dismissals (pair TEXT PRIMARY KEY CHECK(length(pair)=64), created_at INTEGER NOT NULL) STRICT');
}
