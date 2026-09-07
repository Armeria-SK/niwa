import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path: string, schema: string | readonly string[]): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON;');
    const migrations = typeof schema === 'string' ? [schema] : schema;
    transaction(db, () => {
      const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (user_version > migrations.length) throw new Error('Database schema is newer than this application');
      for (let version = user_version; version < migrations.length; version++) {
        db.exec(migrations[version]!);
        db.exec(`PRAGMA user_version = ${version + 1}`);
      }
    });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
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
