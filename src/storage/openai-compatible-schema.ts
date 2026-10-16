import type { DatabaseSync } from 'node:sqlite';
import { ANTHROPIC_AGENTS_CHECK } from './anthropic-schema.ts';
import { LOCAL_LLM_AGENTS_CHECK } from './local-llm-schema.ts';

const PREVIOUS = "CHECK(provider IN ('openai_subscription','ollama'))";
const NEXT = "CHECK(provider IN ('openai_subscription','ollama','openai_compatible'))";

/** Idempotent: databases rewound for upgrade tests may already carry these changes.
 * Widens the agents.provider CHECK in place. Rebuilding agents would cascade deletes through its references,
 * so this uses SQLite's documented schema edit for constraint-only changes and fails closed when the text differs. */
export function openaiCompatibleSchema(db: DatabaseSync): void {
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='agents'").get();
  const sql = typeof row?.sql === 'string' ? row.sql : '';
  // A later migration may already have widened the constraint further.
  if ([NEXT, ANTHROPIC_AGENTS_CHECK, LOCAL_LLM_AGENTS_CHECK].every(text => sql.split(text).length !== 2)) widen(db, sql);
  const columns = new Set(db.prepare('PRAGMA table_info(model_settings)').all().map(column => column.name));
  if (!columns.has('compatible_url')) db.exec('ALTER TABLE model_settings ADD COLUMN compatible_url TEXT');
  if (!columns.has('compatible_parallel')) db.exec('ALTER TABLE model_settings ADD COLUMN compatible_parallel INTEGER NOT NULL DEFAULT 2 CHECK(compatible_parallel BETWEEN 1 AND 8)');
  if (!columns.has('fallback_provider')) db.exec("ALTER TABLE model_settings ADD COLUMN fallback_provider TEXT NOT NULL DEFAULT 'ollama' CHECK(fallback_provider IN ('ollama','openai_compatible'))");
}
function widen(db: DatabaseSync, sql: string): void {
  if (sql.split(PREVIOUS).length !== 2) throw new Error('Unexpected agents schema');
  const version = Number(db.prepare('PRAGMA schema_version').get()!.schema_version);
  db.exec('PRAGMA writable_schema=ON');
  try {
    db.prepare("UPDATE sqlite_schema SET sql=? WHERE type='table' AND name='agents'").run(sql.replace(PREVIOUS, NEXT));
    db.exec(`PRAGMA schema_version=${version + 1}`);
  } finally { db.exec('PRAGMA writable_schema=OFF'); }
  const check = db.prepare('PRAGMA integrity_check').all();
  if (check.length !== 1 || check[0]!.integrity_check !== 'ok') throw new Error('Schema integrity check failed');
}
