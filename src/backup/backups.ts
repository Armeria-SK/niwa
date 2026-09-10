import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { Runtime } from '../runtime/runtime.ts';
import { assertDirectoryPath, type ProductPaths } from '../config/paths.ts';
import type { Installation } from '../config/installation.ts';

export interface BackupManifest {
  version: 1; id: string; created_at: number; installation: Installation;
  files: { path: string; bytes: number; sha256: string }[];
}
const validId = (id: string) => /^[0-9a-f-]{36}$/.test(id);
const damagedBackup = '確認できないバックアップがあります。該当する保存物は削除せず、新しいバックアップの保存を続けます。';

/** Shared by listing and restore; a partial manifest is never a completed snapshot. */
export function validateBackupManifest(manifest: BackupManifest): Set<string> {
  if (!manifest || manifest.version !== 1 || !validId(manifest.id) || !Number.isSafeInteger(manifest.created_at) || manifest.created_at < 0
    || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 1001) throw new Error('Invalid backup files');
  const names = new Set<string>();
  for (const file of manifest.files) {
    if (!file || !/^(control\.db|agents\/[0-9a-f-]{36}\/memory\.db)\.gz$/.test(file.path) || names.has(file.path)
      || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error('Invalid backup file');
    names.add(file.path);
  }
  if (!names.has('control.db.gz')) throw new Error('Missing control database');
  return names;
}

/** Only the trusted service uses this object; no paths or credentials come from a model. */
export class Backups {
  #runtime: Runtime;
  #paths: ProductPaths;
  #installation: Installation;
  #job: Promise<BackupManifest> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #stopped = false;
  #checking: Promise<void> | undefined;
  #lastCompletedAt = 0;
  #failure: string | null = null;
  #listError: string | null = null;
  get error(): string | null { return this.#failure ?? this.#listError; }
  constructor(runtime: Runtime, paths: ProductPaths, installation: Installation, private clock = () => Date.now()) {
    this.#runtime = runtime; this.#paths = paths; this.#installation = installation;
  }
  async list(): Promise<BackupManifest[]> {
    assertDirectoryPath(this.#paths.backups);
    const manifests: BackupManifest[] = [];
    let invalid = false;
    for (const entry of await fs.readdir(this.#paths.backups, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validId(entry.name)) continue;
      try {
        const directory = join(this.#paths.backups, entry.name); assertDirectoryPath(directory);
        const file = join(directory, 'manifest.json');
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error('Invalid backup manifest');
        const value = JSON.parse(await fs.readFile(file, 'utf8')) as BackupManifest;
        validateBackupManifest(value);
        if (value.id !== entry.name) throw new Error('Invalid backup manifest');
        for (const item of value.files) {
          const path = join(directory, item.path); assertDirectoryPath(dirname(path));
          const info = await fs.lstat(path);
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== item.bytes) throw new Error('Incomplete backup');
        }
        manifests.push(value);
      } catch { invalid = true; } // Leave damaged entries intact; neither retention nor restore may adopt them.
    }
    this.#listError = invalid ? damagedBackup : null;
    return manifests.sort((a, b) => b.created_at - a.created_at);
  }
  create(): Promise<BackupManifest> {
    if (this.#job) return this.#job;
    this.#job = this.#create().finally(() => { this.#job = undefined; });
    return this.#job;
  }
  async #create(): Promise<BackupManifest> {
    const admin = this.#runtime.administrator();
    const id = randomUUID(); const created_at = this.clock();
    // Keep staging on the destination mount: systemd bind-mounts writable paths separately.
    const parent = join(this.#paths.backups, '.staging');
    assertDirectoryPath(parent); await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const stage = join(parent, id);
    try {
      // No await inside snapshot: control and private DBs represent one application boundary.
      const names = this.#runtime.snapshot(admin, stage);
      const manifest: BackupManifest = { version: 1, id, created_at, installation: this.#installation, files: [] };
      for (const name of names) {
        const raw = join(stage, name); const compressed = `${raw}.gz`;
        await pipeline(createReadStream(raw), createGzip(), createWriteStream(compressed, { flags: 'wx', mode: 0o600 }));
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(compressed)) hash.update(chunk as Buffer);
        manifest.files.push({ path: `${name}.gz`, bytes: (await fs.stat(compressed)).size, sha256: hash.digest('hex') });
        await fs.unlink(raw);
      }
      await fs.writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
      assertDirectoryPath(this.#paths.backups);
      await fs.rename(stage, join(this.#paths.backups, id));
      this.#lastCompletedAt = Math.max(this.#lastCompletedAt, created_at);
      const cutoff = created_at - this.#runtime.settings(admin).backupDays * 86_400_000;
      for (const old of await this.list()) if (old.id !== id && old.created_at < cutoff) {
        const target = resolve(this.#paths.backups, old.id);
        if (!validId(old.id) || target !== join(this.#paths.backups, old.id)) throw new Error('Invalid backup path');
        assertDirectoryPath(target); await fs.rm(target, { recursive: true });
      }
      this.#failure = null;
      return manifest;
    } catch (error) {
      this.#failure = 'バックアップを保存できませんでした。保存先と空き容量を確認してください。';
      throw error;
    } finally {
      assertDirectoryPath(stage); await fs.rm(stage, { recursive: true, force: true });
    }
  }
  start(): void {
    if (this.#timer) return;
    this.#stopped = false;
    this.#timer = setInterval(() => { void this.tick(); }, 60_000);
    void this.tick();
  }
  tick(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    return this.#checking ??= this.#daily().catch(() => {
      this.#failure = 'バックアップを保存できませんでした。保存先と空き容量を確認してください。';
    }).finally(() => { this.#checking = undefined; });
  }
  async #daily(): Promise<void> {
    if (!this.#runtime.settings(this.#runtime.administrator()).backupEnabled) return;
    const items = await this.list();
    if (this.#stopped) return;
    const now = this.clock(); const day = Math.floor((now + 9 * 3600_000) / 86400_000) * 86400_000 - 9 * 3600_000;
    const settings = this.#runtime.settings(this.#runtime.administrator());
    if (!settings.backupEnabled) return;
    const [hour, minute] = settings.backupTime.split(':').map(Number);
    const due = day + hour! * 3600_000 + minute! * 60_000;
    if (now >= due && Math.max(items[0]?.created_at ?? 0, this.#lastCompletedAt) < day) await this.create();
  }
  async stop(): Promise<void> {
    this.#stopped = true; clearInterval(this.#timer); this.#timer = undefined;
    await this.#checking; await this.#job?.catch(() => {});
  }
}
