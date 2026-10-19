import type { DatabaseSync } from 'node:sqlite';

/** Idempotent: databases rewound for upgrade tests may already carry the columns. input_tokens stays the total; these say how much of it
 * the provider read from or wrote to its prompt cache, and stay empty when the provider does not report it. */
export function promptCacheSchema(db: DatabaseSync): void {
  const columns = new Set(db.prepare('PRAGMA table_info(prompt_runs)').all().map(column => column.name));
  if (!columns.has('cache_read_input_tokens')) db.exec('ALTER TABLE prompt_runs ADD COLUMN cache_read_input_tokens INTEGER');
  if (!columns.has('cache_creation_input_tokens')) db.exec('ALTER TABLE prompt_runs ADD COLUMN cache_creation_input_tokens INTEGER');
}
