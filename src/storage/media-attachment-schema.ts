import type { DatabaseSync } from 'node:sqlite';
import { editSchema } from './database.ts';

const PREVIOUS = 'size INTEGER NOT NULL CHECK(size BETWEEN 0 AND 262144)';
const NEXT = 'size INTEGER NOT NULL CHECK(size BETWEEN 0 AND 4194304)';

/** Idempotent: databases rewound for upgrade tests may already carry these changes.
 * Attachments may now be images and PDFs: the size limit is widened in place (every stored row already fits), the kind and the bytes get columns,
 * and Niwa records which Bot's model could not see an attached image so the conversation can say so. Existing rows stay text. */
export function mediaAttachmentSchema(db: DatabaseSync): void {
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='message_attachments'").get();
  const sql = typeof row?.sql === 'string' ? row.sql : '';
  if (sql.split(NEXT).length !== 2) {
    if (sql.split(PREVIOUS).length !== 2) throw new Error('Unexpected message_attachments schema');
    const version = Number(db.prepare('PRAGMA schema_version').get()!.schema_version);
    editSchema(db, () => {
      db.prepare("UPDATE sqlite_schema SET sql=? WHERE type='table' AND name='message_attachments'").run(sql.replace(PREVIOUS, NEXT));
      db.exec(`PRAGMA schema_version=${version + 1}`);
    });
    const check = db.prepare('PRAGMA integrity_check').all();
    if (check.length !== 1 || check[0]!.integrity_check !== 'ok') throw new Error('Schema integrity check failed');
  }
  const columns = new Set(db.prepare('PRAGMA table_info(message_attachments)').all().map(column => column.name));
  if (!columns.has('media_type')) db.exec("ALTER TABLE message_attachments ADD COLUMN media_type TEXT NOT NULL DEFAULT 'text/plain' CHECK(media_type IN ('text/plain','image/png','image/jpeg','image/gif','image/webp','application/pdf'))");
  if (!columns.has('data')) db.exec('ALTER TABLE message_attachments ADD COLUMN data BLOB');
  db.exec(`CREATE TABLE IF NOT EXISTS attachment_views (attachment_id TEXT NOT NULL REFERENCES message_attachments(id) ON DELETE CASCADE, agent_id TEXT NOT NULL,
    seen INTEGER NOT NULL CHECK(seen IN (0,1)), model TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(attachment_id, agent_id)) STRICT`);
}
