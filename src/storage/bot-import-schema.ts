import type { DatabaseSync } from 'node:sqlite';

/** Idempotent: databases rewound for upgrade tests may already carry these changes.
 * A Bot brought in from a file, once per request id: what was asked (a resend with other input is refused), the Bot that was made,
 * the shared conversation with the administrator's messages its procedures and memories cite, and when those were written into its memory. */
export function botImportSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS bot_imports (id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id),
    room_id TEXT REFERENCES rooms(id), message_ids TEXT NOT NULL, completed_at INTEGER) STRICT`);
}
