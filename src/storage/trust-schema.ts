import type { DatabaseSync } from 'node:sqlite';

/** Idempotent: databases rewound for upgrade tests may already carry these changes.
 * The kind of operation each approval was asked for, a history of decisions (approval_requests keeps only the latest per task),
 * the kinds the administrator let a Bot do without asking, and suggestions they declined. Existing approvals have no kind and are never suggested. */
export function trustSchema(db: DatabaseSync): void {
  const columns = new Set(db.prepare('PRAGMA table_info(approval_requests)').all().map(column => column.name));
  if (!columns.has('kind')) db.exec('ALTER TABLE approval_requests ADD COLUMN kind TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS approval_history (id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), agent_id TEXT NOT NULL,
    kind TEXT NOT NULL, operation TEXT, decision TEXT NOT NULL CHECK(decision IN ('approved','declined','auto')), decided_at INTEGER NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS approval_history_kind ON approval_history(agent_id, kind, id);
    CREATE TABLE IF NOT EXISTS approval_grants (agent_id TEXT NOT NULL, kind TEXT NOT NULL, streak INTEGER NOT NULL, granted_at INTEGER NOT NULL, PRIMARY KEY(agent_id, kind)) STRICT;
    CREATE TABLE IF NOT EXISTS approval_grant_dismissals (agent_id TEXT NOT NULL, kind TEXT NOT NULL, streak INTEGER NOT NULL, dismissed_at INTEGER NOT NULL, PRIMARY KEY(agent_id, kind)) STRICT;`);
}
