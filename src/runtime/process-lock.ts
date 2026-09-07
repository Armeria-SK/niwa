import { DatabaseSync } from 'node:sqlite';
import { lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { assertDirectoryPath } from '../config/paths.ts';

/** A dedicated SQLite exclusive lock is released by the OS even after a process crash. Never unlink it. */
export function acquireProcessLock(path: string): () => void {
  assertDirectoryPath(dirname(path));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Unsafe process lock path');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const db = new DatabaseSync(path);
  try { db.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS process_lock(id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;'); }
  catch { db.close(); throw new Error('Another Niwa service may already be using this product root.'); }
  let closed = false;
  return () => { if (!closed) { db.close(); closed = true; } };
}
