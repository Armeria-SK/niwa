import { createHash, randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { assertDirectoryPath } from '../../config/paths.ts';
import { openDatabase, transaction } from '../../storage/database.ts';
import type { PackageCatalog, ApprovedPackage } from './catalog.ts';
import type { PackageResult } from './install.ts';

export interface PackageOperation { operation_id: string; agent_id: string; room_id: string; task_id: string; allow_start: boolean; names: string[] }
export type PackageOutcome = PackageResult | { error: 'outcome_unknown' };
type Installer = (image: string, name: string, entries: ApprovedPackage[], signal?: AbortSignal) => Promise<PackageResult>;

/** Single executor process owns this journal. Its process lock must outlive the queue. */
export class PackageLog {
  #db: DatabaseSync;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;
  constructor(file: string, private baseImage: string, private catalog: PackageCatalog, private install: Installer) {
    if (!isAbsolute(file) || !/^sha256:[a-f0-9]{64}$/.test(baseImage)) throw new Error('Explicit package state required');
    assertDirectoryPath(dirname(file));
    try { const info = lstatSync(file); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Unsafe package state'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.#db = openDatabase(file, `CREATE TABLE environment (id INTEGER PRIMARY KEY CHECK(id=1),base_image TEXT NOT NULL,image TEXT NOT NULL) STRICT;
      CREATE TABLE installs (operation_id TEXT PRIMARY KEY,input_hash TEXT NOT NULL,container TEXT NOT NULL,output TEXT) STRICT;
      CREATE TABLE installed (name TEXT PRIMARY KEY,version TEXT NOT NULL) STRICT;`);
    this.#db.exec('PRAGMA synchronous=FULL;');
    this.#db.prepare('INSERT INTO environment VALUES (1,?,?) ON CONFLICT DO NOTHING').run(baseImage, baseImage);
    if (this.#db.prepare('SELECT base_image FROM environment').get()!.base_image !== baseImage) { this.#db.close(); throw new Error('Package base image changed'); }
  }
  currentImage(): string { return this.#db.prepare('SELECT image FROM environment WHERE id=1').get()!.image as string; }
  list() { return { available: this.catalog.list(), installed: this.#db.prepare('SELECT name,version FROM installed ORDER BY name').all() }; }
  pending(): string[] { return this.#db.prepare('SELECT container FROM installs WHERE output IS NULL').all().map(row => row.container as string); }
  async close(): Promise<void> { this.#closed = true; await this.#queue; this.#db.close(); }
  execute(input: PackageOperation, signal?: AbortSignal): Promise<PackageOutcome> {
    if (this.#closed) return Promise.reject(new Error('Package executor closed'));
    if (typeof input.allow_start !== 'boolean' || ![input.operation_id, input.agent_id, input.room_id, input.task_id].every(id => typeof id === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(id)))
      return Promise.reject(new Error('Invalid package operation'));
    const entries = this.catalog.select(input.names);
    const snapshot = { ...input, names: entries.map(entry => entry.name) };
    const hash = createHash('sha256').update(JSON.stringify([this.baseImage, this.catalog.revision, snapshot.agent_id, snapshot.room_id, snapshot.task_id, entries])).digest('hex');
    const work = this.#queue.then(async (): Promise<PackageOutcome> => {
      signal?.throwIfAborted();
      const prior = this.#db.prepare('SELECT input_hash,output FROM installs WHERE operation_id=?').get(snapshot.operation_id);
      if (prior) {
        if (prior.input_hash !== hash) throw new Error('Package operation conflicts with saved request');
        return prior.output === null ? { error: 'outcome_unknown' } : JSON.parse(prior.output as string) as PackageResult;
      }
      if (!snapshot.allow_start) return { error: 'outcome_unknown' };
      const name = `niwa-package-${randomUUID()}`;
      this.#db.prepare('INSERT INTO installs VALUES (?,?,?,NULL)').run(snapshot.operation_id, hash, name);
      try {
        const result = await this.install(this.currentImage(), name, entries, signal);
        if (!('error' in result) && (!/^sha256:[a-f0-9]{64}$/.test(result.image) ||
          JSON.stringify(result.installed) !== JSON.stringify(entries.map(({ name, version }) => ({ name, version }))))) throw new Error('Invalid installed environment');
        if ('error' in result && result.error !== 'installation_failed') throw new Error('Invalid package result');
        transaction(this.#db, () => {
          if (!('error' in result)) {
            this.#db.prepare('UPDATE environment SET image=? WHERE id=1').run(result.image);
            for (const item of result.installed) this.#db.prepare('INSERT INTO installed VALUES (?,?) ON CONFLICT(name) DO UPDATE SET version=excluded.version').run(item.name, item.version);
          }
          this.#db.prepare('UPDATE installs SET output=? WHERE operation_id=?').run(JSON.stringify(result), snapshot.operation_id);
        });
        return result;
      } catch { return { error: 'outcome_unknown' }; }
    });
    this.#queue = work.catch(() => {}); return work;
  }
}
