import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** A function step runs inside the migration transaction for changes plain SQL cannot express safely. */
export type Migration = string | ((db: DatabaseSync) => void);
export function openDatabase(path: string, schema: string | readonly Migration[]): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  // Defensive mode is the Node 24.20 default; asking for it keeps earlier 24.x builds the same. editSchema lifts it only for a schema edit.
  const db = new DatabaseSync(path, { defensive: true });
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON;');
    const migrations = typeof schema === 'string' ? [schema] : schema;
    transaction(db, () => {
      const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (user_version > migrations.length) throw new Error('Database schema is newer than this application');
      for (let version = user_version; version < migrations.length; version++) {
        const migration = migrations[version]!;
        if (typeof migration === 'string') db.exec(migration); else migration(db);
        db.exec(`PRAGMA user_version = ${version + 1}`);
      }
    });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Runs SQLite's documented in-place schema edit (writable_schema and a schema_version bump). Databases open in defensive mode,
 * which refuses both, so the flag is lifted only for the edit and set again after; Node versions without the switch never set it. */
export function editSchema(db: DatabaseSync, edit: () => void): void {
  const defensive = typeof db.enableDefensive === 'function' ? (active: boolean) => db.enableDefensive(active) : undefined;
  defensive?.(false);
  db.exec('PRAGMA writable_schema=ON');
  try { edit(); }
  finally { db.exec('PRAGMA writable_schema=OFF'); defensive?.(true); }
}

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  const nested = db.isTransaction;
  db.exec(nested ? 'SAVEPOINT niwa_nested' : 'BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec(nested ? 'RELEASE niwa_nested' : 'COMMIT');
    return result;
  } catch (error) {
    db.exec(nested ? 'ROLLBACK TO niwa_nested; RELEASE niwa_nested' : 'ROLLBACK');
    throw error;
  }
}
