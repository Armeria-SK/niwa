import type { DatabaseSync } from 'node:sqlite';
import { editSchema } from './database.ts';

const PREVIOUS = 'task_id TEXT NOT NULL REFERENCES tasks(id)';
const NEXT = 'task_id TEXT REFERENCES tasks(id)';

/** Idempotent: databases rewound for upgrade tests may already carry this change.
 * Model calls the administrator asks for outside any work (a second opinion on a reply, a model check of an artifact) are counted in prompt_runs
 * with no task. Dropping NOT NULL is a constraint-only edit that leaves stored rows as they are, so it is made in place like the provider edits. */
export function secondOpinionSchema(db: DatabaseSync): void {
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='prompt_runs'").get();
  const sql = typeof row?.sql === 'string' ? row.sql : '';
  if (sql.split(NEXT).length === 2 && sql.split(PREVIOUS).length === 1) return;
  if (sql.split(PREVIOUS).length !== 2) throw new Error('Unexpected prompt_runs schema');
  const version = Number(db.prepare('PRAGMA schema_version').get()!.schema_version);
  editSchema(db, () => {
    db.prepare("UPDATE sqlite_schema SET sql=? WHERE type='table' AND name='prompt_runs'").run(sql.replace(PREVIOUS, NEXT));
    db.exec(`PRAGMA schema_version=${version + 1}`);
  });
  const check = db.prepare('PRAGMA integrity_check').all();
  if (check.length !== 1 || check[0]!.integrity_check !== 'ok') throw new Error('Schema integrity check failed');
}
