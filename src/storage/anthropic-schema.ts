import type { DatabaseSync } from 'node:sqlite';

const AGENTS = ["CHECK(provider IN ('openai_subscription','ollama','openai_compatible'))", "CHECK(provider IN ('openai_subscription','ollama','openai_compatible','anthropic'))"] as const;
const FALLBACK = ["CHECK(fallback_provider IN ('ollama','openai_compatible'))", "CHECK(fallback_provider IN ('ollama','openai_compatible','anthropic'))"] as const;
/** Constraint text after this migration; the OpenAI-compatible step accepts it as already widened when a rewound database is replayed. */
export const ANTHROPIC_AGENTS_CHECK = AGENTS[1];

/** Idempotent: databases rewound for upgrade tests may already carry these changes.
 * Widens agents.provider and model_settings.fallback_provider in place with the same constraint-only schema edit as
 * openaiCompatibleSchema (rebuilding agents would cascade deletes through its references) and fails closed when the text differs. */
export function anthropicSchema(db: DatabaseSync): void {
  const edits = (['agents', 'model_settings'] as const).map((table, index) => {
    const [previous, next] = index === 0 ? AGENTS : FALLBACK;
    const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table);
    const sql = typeof row?.sql === 'string' ? row.sql : '';
    if (sql.split(next).length === 2) return undefined;
    if (sql.split(previous).length !== 2) throw new Error(`Unexpected ${table} schema`);
    return { table, sql: sql.replace(previous, next) };
  }).filter(edit => edit !== undefined);
  if (edits.length) {
    const version = Number(db.prepare('PRAGMA schema_version').get()!.schema_version);
    db.exec('PRAGMA writable_schema=ON');
    try {
      for (const edit of edits) db.prepare("UPDATE sqlite_schema SET sql=? WHERE type='table' AND name=?").run(edit.sql, edit.table);
      db.exec(`PRAGMA schema_version=${version + 1}`);
    } finally { db.exec('PRAGMA writable_schema=OFF'); }
    const check = db.prepare('PRAGMA integrity_check').all();
    if (check.length !== 1 || check[0]!.integrity_check !== 'ok') throw new Error('Schema integrity check failed');
  }
  const columns = new Set(db.prepare('PRAGMA table_info(model_settings)').all().map(column => column.name));
  if (!columns.has('anthropic_parallel')) db.exec('ALTER TABLE model_settings ADD COLUMN anthropic_parallel INTEGER NOT NULL DEFAULT 2 CHECK(anthropic_parallel BETWEEN 1 AND 8)');
}
