import type { DatabaseSync } from 'node:sqlite';
import { editSchema } from './database.ts';

// The local-model provider id was stored as 'ollama' before it became Niwa's own name 'local_llm'.
const LEGACY = 'ollama';
const CURRENT = 'local_llm';
const EDITS = [
  ['agents', "CHECK(provider IN ('openai_subscription','ollama','openai_compatible','anthropic'))", "CHECK(provider IN ('openai_subscription','local_llm','openai_compatible','anthropic'))"],
  ['model_settings', "DEFAULT 'ollama' CHECK(fallback_provider IN ('ollama','openai_compatible','anthropic'))", "DEFAULT 'local_llm' CHECK(fallback_provider IN ('local_llm','openai_compatible','anthropic'))"],
] as const;
/** Constraint text after this migration; earlier replayed steps accept it as already widened. */
export const LOCAL_LLM_AGENTS_CHECK = EDITS[0][2];
export const LOCAL_LLM_FALLBACK_CHECK = EDITS[1][2];

/** Idempotent: databases rewound for upgrade tests may already carry these changes.
 * Renames the stored provider id and the endpoint column. The CHECK and DEFAULT texts are edited in place (rebuilding agents would cascade deletes
 * through its references); SQLite does not revalidate rows on that edit, so every stored id is rewritten in the same transaction and verified, failing closed. */
export function localLlmSchema(db: DatabaseSync): void {
  const edits = EDITS.map(([table, previous, next]) => {
    const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table);
    const sql = typeof row?.sql === 'string' ? row.sql : '';
    if (sql.split(next).length === 2) return undefined;
    if (sql.split(previous).length !== 2) throw new Error(`Unexpected ${table} schema`);
    return { table, sql: sql.replace(previous, next) };
  }).filter(edit => edit !== undefined);
  if (edits.length) {
    const version = Number(db.prepare('PRAGMA schema_version').get()!.schema_version);
    editSchema(db, () => {
      for (const edit of edits) db.prepare("UPDATE sqlite_schema SET sql=? WHERE type='table' AND name=?").run(edit.sql, edit.table);
      db.exec(`PRAGMA schema_version=${version + 1}`);
    });
  }
  // Every column that stores a provider id. Routes and the new-Bot default have no CHECK but are compared with agents.provider when read.
  for (const [table, column] of [['agents', 'provider'], ['model_settings', 'fallback_provider'], ['generated_model', 'provider'], ['model_routes', 'provider']] as const)
    db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${column}=?`).run(CURRENT, LEGACY);
  // Review records name the reviewing model as provider/model/reasoning.
  db.prepare("UPDATE artifact_reviews SET review_model=?||substr(review_model,?) WHERE substr(review_model,1,?)=?").run(`${CURRENT}/`, LEGACY.length + 2, LEGACY.length + 1, `${LEGACY}/`);
  const columns = new Set(db.prepare('PRAGMA table_info(model_settings)').all().map(column => column.name));
  if (columns.has('ollama_url')) {
    if (columns.has('local_llm_url')) throw new Error('Unexpected model_settings schema');
    db.exec('ALTER TABLE model_settings RENAME COLUMN ollama_url TO local_llm_url');
  } else if (!columns.has('local_llm_url')) throw new Error('Unexpected model_settings schema');
  const left = db.prepare(`SELECT (SELECT count(*) FROM agents WHERE provider=:id)+(SELECT count(*) FROM model_settings WHERE fallback_provider=:id)
    +(SELECT count(*) FROM generated_model WHERE provider=:id)+(SELECT count(*) FROM model_routes WHERE provider=:id) AS count`).get({ id: LEGACY })!.count;
  if (left !== 0) throw new Error('Legacy provider id remains');
  const check = db.prepare('PRAGMA integrity_check').all();
  if (check.length !== 1 || check[0]!.integrity_check !== 'ok') throw new Error('Schema integrity check failed');
}
